/**
 * 平台模型自动发现服务
 *
 * 定期从每个已启用平台的 /v1/models 端点拉取可用模型列表，
 * 存入 platform_models 表，供路由引擎做模型感知路由。
 *
 * 策略：
 * - 启动时立即执行一次拉取
 * - 之后每 10 分钟定时刷新
 * - 拉取失败时保留旧数据不清理（避免上游临时故障清空模型列表）
 */

import { prisma } from "./prisma";
import { getNextKey, parseApiKeys } from "./platform-keys";
import type { PlatformConfig } from "@/types";

const FETCH_TIMEOUT_MS = 10_000;
const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 分钟

interface UpstreamModel {
  id: string;
  owned_by?: string;
}

/**
 * 从单个平台获取模型列表，失败返回 null（区分"无模型"和"拉取失败"）
 */
export async function fetchPlatformModels(platform: {
  id: string;
  baseUrl: string;
  apiKey: string;
  apiKeys: string;
  name: string;
}): Promise<UpstreamModel[] | null> {
  const url = `${platform.baseUrl.replace(/\/+$/, "")}/models`;

  const extraKeys = parseApiKeys(platform.apiKeys);

  const apiKey = getNextKey({
    id: platform.id,
    apiKey: platform.apiKey,
    apiKeys: extraKeys,
  } as PlatformConfig);
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

    const data = await res.json();
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
 * 拉取所有平台的模型并更新数据库
 */
async function fetchAllPlatformModels(): Promise<void> {
  const platforms = await prisma.platform.findMany({
    where: { enabled: true },
    select: { id: true, name: true, baseUrl: true, apiKey: true, apiKeys: true },
  });

  if (platforms.length === 0) return;

  let totalModels = 0;
  let successCount = 0;

  // 并发拉取所有平台
  const results = await Promise.allSettled(
    platforms.map(async (platform) => {
      const models = await fetchPlatformModels(platform);
      if (models === null) {
        // 拉取失败，保留旧数据
        console.warn(
          `[model-fetcher] 平台 ${platform.name}(${platform.id}) 模型拉取失败，保留旧数据`
        );
        return;
      }

      // 事务内替换该平台的模型列表
      const now = new Date();
      await prisma.$transaction(async (tx) => {
        // 删除旧模型
        await tx.platformModel.deleteMany({
          where: { platformId: platform.id },
        });
        // 批量插入新模型
        if (models.length > 0) {
          await tx.platformModel.createMany({
            data: models.map((m) => ({
              platformId: platform.id,
              modelId: m.id,
              ownedBy: m.owned_by ?? platform.name,
              fetchedAt: now,
            })),
          });
        }
      });

      totalModels += models.length;
      successCount++;
    })
  );

  // 统计失败数
  const failCount = results.filter((r) => r.status === "rejected").length;
  if (failCount > 0) {
    console.warn(`[model-fetcher] ${failCount} 个平台拉取失败`);
  }

  console.log(
    `[model-fetcher] 拉取完成: ${successCount}/${platforms.length} 个平台, ${totalModels} 个模型`
  );
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 启动模型拉取服务
 *
 * 立即执行一次拉取，之后每 10 分钟定时刷新。
 * 可多次调用，只会启动一个定时器。
 */
export function startModelFetcher(): void {
  if (refreshTimer) return;

  console.log("[model-fetcher] 启动模型拉取服务");

  // 立即执行一次（不等待结果，后台运行）
  fetchAllPlatformModels().catch((err) => {
    console.error("[model-fetcher] 首次拉取异常:", err);
  });

  // 定时刷新
  refreshTimer = setInterval(() => {
    fetchAllPlatformModels().catch((err) => {
      console.error("[model-fetcher] 定时拉取异常:", err);
    });
  }, REFRESH_INTERVAL_MS);
}

/**
 * 停止模型拉取服务（用于测试或优雅关闭）
 */
export function stopModelFetcher(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
