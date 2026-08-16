/**
 * 平台模型自动发现服务（Cron 任务）
 *
 * 定期从每个已启用平台的 /v1/models 端点拉取可用模型列表，
 * 存入 platform_models 表，供路由引擎做模型感知路由。
 *
 * 策略：
 * - 每 6 小时定时刷新
 * - 拉取失败时保留旧数据不清理
 * - 使用事务替换每个平台的模型列表（非 D1 数据库）
 * - 锁等待超时自动重试（指数退避）
 */

import { createDb, getDbKind } from "@/lib/prisma";
import { detectModelType } from "@/lib/detect-model-type";
import type { WorkerEnv } from "./config";
import { parseApiKeys, parseApiKeyObjects, getNextKey } from "./platform-keys";
import { isSafeUrl } from "@/lib/admin-security";
import { getUpstreamProxyDispatcher } from "@/lib/upstream-proxy";
import type { PlatformConfig } from "@/lib/types";

const FETCH_TIMEOUT_MS = 10_000;

/** MySQL/TiDB 锁等待超时错误码 */
const LOCK_WAIT_TIMEOUT_CODE = 1205;
/** 最大重试次数 */
const MAX_RETRIES = 3;
/** 初始重试延迟（毫秒） */
const INITIAL_RETRY_DELAY_MS = 100;

/**
 * 判断错误是否为锁等待超时
 */
function isLockWaitTimeout(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  // Prisma 错误结构：{ code: 'P2034', meta: { code: 1205, ... } }
  if (e.code === "P2034") return true;
  // 原生 MySQL 错误
  if (typeof e.meta === "object" && e.meta !== null) {
    const meta = e.meta as Record<string, unknown>;
    if (meta.code === LOCK_WAIT_TIMEOUT_CODE) return true;
  }
  // 直接包含错误码的情况
  if (typeof e.message === "string" && e.message.includes("1205")) return true;
  if (typeof e.message === "string" && e.message.includes("Lock wait timeout")) return true;
  return false;
}

/**
 * 带重试的事务执行（仅非 D1 数据库）
 * D1 不支持事务，直接执行不重试
 */
async function executeWithRetry<T>(
  prisma: any,
  dbKind: string,
  fn: (tx: any) => Promise<T>,
  operationName: string
): Promise<T> {
  // D1 不支持事务，也不重试（D1 无锁等待超时问题）
  if (dbKind === "d1") {
    return fn(prisma);
  }

  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // 非 D1 数据库使用事务：fn 内所有查询必须使用 tx（事务客户端），保证删除+插入原子替换
      return await prisma.$transaction(async (tx: any) => {
        return await fn(tx);
      });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (isLockWaitTimeout(err) && attempt < MAX_RETRIES) {
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `[model-fetcher] ${operationName} 遇到锁等待超时 (尝试 ${attempt + 1}/${MAX_RETRIES + 1})，${delay}ms 后重试: ${lastError.message}`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw lastError;
    }
  }
  throw lastError;
}

interface UpstreamModel {
  id: string;
  owned_by?: string;
}

/**
 * 从单个平台获取模型列表
 */
async function fetchPlatformModels(
  platform: {
    id: string;
    baseUrl: string;
    apiKeys: string;
    name: string;
  },
  db: D1Database,
  env?: WorkerEnv
): Promise<UpstreamModel[] | null> {
  const url = `${platform.baseUrl.replace(/\/+$/, "")}/models`;

  // SSRF 防护：模型拉取同样必须校验上游地址（此前无校验，平台 baseUrl 指向内网时
  // 会形成盲 SSRF——响应数据入库后可经未认证 GET /v1/models 外带）。
  // 用 isSafeUrl（含 DNS 解析层，防 AAAA-only 内网域名/DNS Rebinding）；定时任务非热路径，
  // DNS 开销可接受；workerd 无 node:dns 时内部降级为 hostname 层
  const urlCheck = await isSafeUrl(platform.baseUrl);
  if (!urlCheck.safe) {
    console.warn(
      `[model-fetcher] 平台 ${platform.name}(${platform.id}) 上游 URL 不安全，跳过: ${urlCheck.reason}`
    );
    return null;
  }

  const parsedKeys = parseApiKeys(platform.apiKeys);
  const platformConfig: PlatformConfig = {
    id: platform.id,
    name: platform.name,
    baseUrl: platform.baseUrl,
    apiKeys: parsedKeys,
    apiKeyObjects: parseApiKeyObjects(platform.apiKeys),
    type: "openai",
    enabled: true,
    priority: 0,
    weight: 1,
    rpmLimit: null,
    tpmLimit: null,
    forwardHeaders: "[]",
    injectStreamOptions: true,
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

    // 出站代理（仅 Docker 部署）：请求经代理服务器访问上游
    const dispatcher = await getUpstreamProxyDispatcher(db, env);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      // 禁止跟随重定向：校验只作用于初始 URL，跟随 3xx 可能重定向到内网
      redirect: "manual",
      ...(dispatcher ? { dispatcher } : {}),
    });
    clearTimeout(timeoutId);

    if (!res.ok) return null;

    const data: any = await res.json();
    const list: unknown[] = Array.isArray(data) ? data : data?.data;
    if (!Array.isArray(list)) return null;

    const models = list
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

    // 上游返回空列表视为获取失败，保留旧数据不清空
    if (models.length === 0) return null;

    // 按 id 去重：个别供应商返回重复 id 时 createMany 会撞 @@unique([platformId, modelId]) 整批失败
    const deduped = Array.from(new Map(models.map((m) => [m.id, m])).values());

    return deduped;
  } catch {
    return null;
  }
}

/**
 * 拉取所有平台的模型并更新数据库
 */
export async function fetchAllPlatformModels(db: D1Database, env?: WorkerEnv): Promise<void> {
  const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
  const dbKind = await getDbKind({ DB: db, DB_TYPE: env?.DB_TYPE });

  try {
    const platforms = await prisma.platforms.findMany({
      where: { enabled: true },
      select: {
        id: true,
        name: true,
        baseUrl: true,
        apiKeys: true,
      },
    });

    if (platforms.length === 0) return;

    let totalModels = 0;
    let successCount = 0;

    type PlatformSelect = { id: string; name: string; baseUrl: string; apiKeys: string };
    type ExistingModel = { modelId: string; enabled: boolean; source: string };

    const results = await Promise.allSettled(
      platforms.map(async (platform: PlatformSelect) => {
        const models = await fetchPlatformModels(platform, db, env);
        if (models === null) {
          console.warn(
            `[model-fetcher] 平台 ${platform.name}(${platform.id}) 模型拉取失败，保留旧数据`
          );
          return;
        }

        // 事务内替换该平台的模型列表（带重试）
        const now = Math.floor(Date.now() / 1000);

        await executeWithRetry(
          prisma,
          dbKind,
          async (tx: any) => {
            // 查询已有模型，保留用户手动设置的 enabled 状态
            const existingModels: ExistingModel[] = await tx.platformModels.findMany({
              where: { platformId: platform.id },
              select: { modelId: true, enabled: true, source: true },
            });
            const existingMap = new Map(
              existingModels.map((m: ExistingModel) => [m.modelId, { enabled: m.enabled, source: m.source } as const])
            );

            // 删除旧的自动发现模型（保留手动添加的）
            await tx.platformModels.deleteMany({
              where: { platformId: platform.id, source: "auto" },
            });

            // 批量插入新模型，保留已有模型的 enabled 状态
            if (models.length > 0) {
              const values = models.map((m) => {
                const existing = existingMap.get(m.id);
                return {
                  id: crypto.randomUUID(),
                  platformId: platform.id,
                  modelId: m.id,
                  ownedBy: m.owned_by ?? platform.name,
                  modelName: m.id,
                  type: detectModelType(m.id),
                  source: "auto" as const,
                  fetchedAt: now,
                  // 已有模型保留原 enabled 状态，新模型默认启用
                  enabled: existing ? existing.enabled : true,
                };
              });

              // 分批插入（D1 限制每次最多 100 条）
              for (let i = 0; i < values.length; i += 100) {
                await tx.platformModels.createMany({
                  data: values.slice(i, i + 100),
                });
              }
            }
          },
          `平台 ${platform.name} 模型替换`
        );

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
  } catch (err) {
    console.error("[model-fetcher] 模型拉取任务异常:", err instanceof Error ? err.message : String(err));
  }
}
