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
import { getUpstreamProxy, markProxyFailure } from "@/lib/upstream-proxy";
import { resolvePlatformProtocols, type PlatformConfig, type PlatformType } from "../../lib/types";

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
 * 按协议探测上游模型列表。
 *
 * 返回当前协议命中的模型 id 集合。失败（超时/非 2xx/响应体不识别）返回 null。
 *
 * 协议→端点：
 * - anthropic 协议：官方 Anthropic 没有 /v1/models 端点（SDK 不提供模型发现），
 *   但 GitHub Copilot / Vercel AI Gateway 等 Anthropic 兼容中转通常会实现
 *   OpenAI 风格的 /v1/models。此处按 OpenAI 兼容方式探测（与 openai 协议走同一路径）。
 * - gemini 协议：Google Generative AI ListModels 端点 /v1beta/models?key=...
 *   返回 { models: [{ name: "models/gemini-..." }] } 形态。
 * - openai/azure/custom：标准 /v1/models，返回 { data: [{ id }] } 形态。
 */
async function fetchModelsByProtocol(
  protocol: PlatformType,
  platform: {
    id: string;
    baseUrl: string;
    apiKeys: string;
    name: string;
  },
  db: D1Database,
  env?: WorkerEnv
): Promise<UpstreamModel[] | null> {
  const base = platform.baseUrl.replace(/\/+$/, "");
  let url: string;
  let headers: Record<string, string>;

  if (protocol === "gemini") {
    // Gemini 协议：Key 通过 ?key= 查询参数传（不能用 Authorization Bearer）。
    // 多 Key 时只取首个可用 Key——Gemini 上游一般单 Key 鉴权，与 OpenAI 兼容不同
    const parsedKeys = parseApiKeys(platform.apiKeys);
    if (parsedKeys.length === 0) return null;
    const apiKey = parsedKeys[0];
    url = `${base}/v1beta/models?key=${encodeURIComponent(apiKey)}`;
    headers = {};
  } else {
    // openai / azure / custom / anthropic 兼容：统一走 /v1/models + Bearer
    url = `${base}/models`;
    headers = { Authorization: "" }; // 下面用 platformConfig 选 Key 后再补
  }

  // SSRF 防护：与原实现一致——所有协议都校验 baseUrl
  const urlCheck = await isSafeUrl(platform.baseUrl);
  if (!urlCheck.safe) {
    console.warn(
      `[model-fetcher] 平台 ${platform.name}(${platform.id}) 上游 URL 不安全（${protocol}），跳过: ${urlCheck.reason}`
    );
    return null;
  }

  // 出站代理（仅 Docker 部署）：所有协议共用同一套代理选择
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let proxy: Awaited<ReturnType<typeof getUpstreamProxy>> | null = null;
  let res: Response;

  try {
    proxy = await getUpstreamProxy(db, env, platform.id);
    if (protocol !== "gemini") {
      // OpenAI 兼容路径：取第一个可用 Key 注入 Authorization
      const platformConfig: PlatformConfig = {
        id: platform.id,
        name: platform.name,
        baseUrl: platform.baseUrl,
        apiKeys: parseApiKeys(platform.apiKeys),
        apiKeyObjects: parseApiKeyObjects(platform.apiKeys),
        type: protocol,
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
      headers.Authorization = `Bearer ${apiKey}`;
    }
    res = await fetch(url, {
      headers,
      signal: controller.signal,
      // 禁止跟随重定向：校验只作用于初始 URL
      redirect: "manual",
      ...(proxy.dispatcher ? { dispatcher: proxy.dispatcher } : {}),
    });
  } catch (err) {
    clearTimeout(timeoutId);
    const isAbort = err instanceof DOMException && err.name === "AbortError";
    if (!isAbort && proxy?.url) void markProxyFailure(db, env, proxy.url).catch(() => {});
    return null;
  }
  clearTimeout(timeoutId);

  if (!res.ok) {
    void res.arrayBuffer().catch(() => {});
    return null;
  }

  try {
    const data: any = await res.json();
    let list: unknown[] = [];
    if (protocol === "gemini") {
      // Gemini 响应：{ models: [{ name: "models/gemini-2.0-flash", ... }] }
      if (data && Array.isArray(data.models)) {
        list = data.models
          .map((m: any) => (typeof m?.name === "string" ? m.name : null))
          .filter((n: string | null): n is string => n !== null)
          // Gemini 模型名形如 "models/gemini-2.0-flash"，去掉前缀以与其他协议 id 形态一致
          .map((n: string) => n.replace(/^models\//, ""));
      }
    } else {
      list = Array.isArray(data) ? data : data?.data;
    }
    if (!Array.isArray(list) || list.length === 0) return null;

    const models: UpstreamModel[] = list
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

    if (models.length === 0) return null;
    return models;
  } catch {
    return null;
  }
}

/**
 * 从单个平台按 types 顺序逐协议探测并合并去重。
 *
 * 合并策略：
 * - 严格按 types 顺序探测（types[0] 优先，结果排在前面）
 * - 同一 modelId 在多协议中均出现时保留首次命中的 owned_by
 * - 任意协议返回 null（探测失败）不阻断其它协议；全部失败时返回 null
 */
async function fetchPlatformModels(
  platform: {
    id: string;
    baseUrl: string;
    apiKeys: string;
    name: string;
    type: string;
    types?: string | null;
  },
  db: D1Database,
  env?: WorkerEnv
): Promise<UpstreamModel[] | null> {
  // 解析协议列表：types 缺失/非法回退 [type]（与 router 行为一致）
  const types = resolvePlatformProtocols(platform.types ?? null, platform.type as PlatformType);

  // 按 types 顺序探测，合并去重（保序）
  const merged: UpstreamModel[] = [];
  const seen = new Set<string>();
  let anySuccess = false;
  for (const protocol of types) {
    const models = await fetchModelsByProtocol(protocol, platform, db, env);
    if (models === null) continue;
    anySuccess = true;
    for (const m of models) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        merged.push(m);
      }
    }
  }
  if (!anySuccess) return null;
  return merged;
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
        type: true,
        types: true,
      },
    });

    if (platforms.length === 0) return;

    let totalModels = 0;
    let successCount = 0;

    type PlatformSelect = { id: string; name: string; baseUrl: string; apiKeys: string; type: string; types: string };
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

            // 批量插入新模型，保留已有模型的 enabled 状态。
            // 手动添加的模型未被上方 deleteMany 删除、仍占用 (platformId, modelId)
            // 唯一约束位，必须跳过——否则 createMany 整批失败（D1 无事务，
            // auto 已删无法回滚，导致该平台自动发现模型被清空）。
            if (models.length > 0) {
              const values = models
                .filter((m) => existingMap.get(m.id)?.source !== "manual")
                .map((m) => {
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
