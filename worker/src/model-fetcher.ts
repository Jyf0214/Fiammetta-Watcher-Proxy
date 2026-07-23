/**
 * 平台模型自动发现服务（Cron 任务）
 *
 * 定期从每个已启用平台的 /v1/models 端点拉取可用模型列表，
 * 存入 platform_models 表，供路由引擎做模型感知路由。
 *
 * 策略：
 * - 每 10 分钟定时刷新
 * - 拉取失败时保留旧数据不清理
 * - 使用事务替换每个平台的模型列表
 */

import { createPrismaClient } from "./prisma-db";
import { parseApiKeys, getNextKey } from "./platform-keys";
import type { PlatformConfig } from "@/lib/types";

const FETCH_TIMEOUT_MS = 10_000;

interface UpstreamModel {
  id: string;
  owned_by?: string;
}

/**
 * 从单个平台获取模型列表
 */
async function fetchPlatformModels(platform: {
  id: string;
  baseUrl: string;
  apiKey: string;
  apiKeys: string;
  name: string;
}): Promise<UpstreamModel[] | null> {
  const url = `${platform.baseUrl.replace(/\/+$/, "")}/models`;

  const extraKeys = parseApiKeys(platform.apiKeys);
  const platformConfig: PlatformConfig = {
    id: platform.id,
    name: platform.name,
    baseUrl: platform.baseUrl,
    apiKey: platform.apiKey,
    apiKeys: extraKeys,
    type: "openai",
    enabled: true,
    priority: 0,
    weight: 1,
    rpmLimit: null,
    tpmLimit: null,
    forwardHeaders: "[]",
    status: "healthy",
    failCount: 0,
    lastFailAt: null,
    cooldownEnd: null,
  };

  const apiKey = getNextKey(platformConfig);
  if (!apiKey) return null;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) return null;

    const data: any = await res.json();
    const list: unknown[] = Array.isArray(data) ? data : data?.data;
    if (!Array.isArray(list)) return null;

    return list
      .filter(
        (item): item is UpstreamModel =>
          typeof item === "object" &&
          item !== null &&
          "id" in item &&
          typeof (item as Record<string, unknown>).id === "string"
      )
      .map((m) => ({
        id: m.id,
        owned_by: m.owned_by,
      }));
  } catch {
    return null;
  }
}

/**
 * 判别模型类型（简化版）
 */
function detectModelType(modelId: string): string {
  const id = modelId.toLowerCase();

  if (
    id.includes("dall-e") || id.includes("flux") || id.includes("stable-diffusion") ||
    id.includes("sdxl") || id.includes("cogview") || id.includes("gpt-image") ||
    id.includes("image") || id.startsWith("sd-")
  ) return "image";

  if (
    id.includes("embedding") || id.includes("bge-") || id.includes("e5-") ||
    id.includes("gte-") || id.startsWith("text-embedding")
  ) return "embedding";

  if (
    id.includes("whisper") || id.includes("tts-") || id.includes("speech") ||
    id.includes("cosyvoice") || id.includes("bark")
  ) return "audio";

  return "chat";
}

/**
 * 拉取所有平台的模型并更新数据库
 */
export async function fetchAllPlatformModels(db: D1Database): Promise<void> {
  const prisma = await createPrismaClient(db);

  try {
  const platforms = await prisma.platforms.findMany({
    where: { enabled: true },
    select: {
      id: true,
      name: true,
      baseUrl: true,
      apiKey: true,
      apiKeys: true,
    },
  });

  if (platforms.length === 0) return;

  let totalModels = 0;
  let successCount = 0;

  const results = await Promise.allSettled(
    platforms.map(async (platform) => {
      const models = await fetchPlatformModels(platform);
      if (models === null) {
        console.warn(
          `[model-fetcher] 平台 ${platform.name}(${platform.id}) 模型拉取失败，保留旧数据`
        );
        return;
      }

      // 事务内替换该平台的模型列表
      const now = Math.floor(Date.now() / 1000);

      // 删除旧模型
      await prisma.platformModels.deleteMany({
        where: { platformId: platform.id },
      });

      // 批量插入新模型
      if (models.length > 0) {
        const values = models.map((m) => ({
          id: crypto.randomUUID(),
          platformId: platform.id,
          modelId: m.id,
          ownedBy: m.owned_by ?? platform.name,
          modelName: m.id,
          type: detectModelType(m.id),
          source: "auto" as const,
          fetchedAt: now,
        }));

        // 分批插入（D1 限制每次最多 100 条）
        for (let i = 0; i < values.length; i += 100) {
          await prisma.platformModels.createMany({
            data: values.slice(i, i + 100),
          });
        }
      }

      totalModels += models.length;
      successCount++;

      console.log(
        `[model-fetcher] 平台 ${platform.name} 发现 ${models.length} 个模型`
      );
    })
  );

  // 统计失败
  const failedCount = results.filter((r) => r.status === "rejected").length;

  console.log(
    `[model-fetcher] 完成: ${successCount} 个平台成功, ${failedCount} 个失败, 共发现 ${totalModels} 个模型`
  );

  } finally {
    await prisma.$disconnect();
  }
}
