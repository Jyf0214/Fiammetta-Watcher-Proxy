/**
 * Lite 版路由引擎 — 纯负载均衡，无评分/优先级/熔断器
 *
 * VERSION=lite 时构建使用（见 scripts/worker-lite-gate.sh），以最小化 CPU 运行时间：
 * - 内存缓存平台列表与模型映射（30 秒 TTL），只拉取平台信息
 * - 模型名称解析（精确匹配 + 通配符，与全量版语义一致）
 * - 平台选择：仅按权重加权随机（不读 platform_scores、不按优先级分组、
 *   不维护熔断器状态、不写平台状态）
 * - 冷却期（cooldownEnd）为只读被动过滤：平台处于管理后台设置/全量版遗留的
 *   冷却期时不路由过去，避免把请求打进已知故障平台
 *
 * 注意：与全量版 router.ts 刻意保持独立——lite 构建不引入评分/熔断器相关代码。
 */

import { createDb } from "@/lib/prisma";
import { parseApiKeys, parseApiKeyObjects } from "./platform-keys";
import { getConfig } from "./config";
import type { PlatformConfig, RouteDecision, ModelMapConfig, ApiType } from "@/lib/types";
import type { WorkerEnv } from "./config";
import { loadApiMappings, getApplicableApiMapping, resolveTargetModel as resolveApiTargetModel } from "./api-mappings";

// ==================== 缓存 ====================

let platformCache: PlatformConfig[] = [];
let modelMapCache: ModelMapConfig[] = [];
let platformModelCache: Map<string, Set<string>> = new Map();
let autoModelId: string | null = null;
// 自动模型分流白名单（system:auto_model_selected 配置的模型 ID 集合）；null 表示未配置（全部参与）
let autoModelSelected: Set<string> | null = null;
let lastRefresh = 0;
const CACHE_TTL = 30_000;
const EMPTY_CACHE_RETRY = 5_000;

// ==================== 缓存刷新 ====================

let refreshPromise: Promise<void> | null = null;

/**
 * 刷新平台和模型映射缓存（带防并发穿透锁）
 */
export async function refreshCacheLite(db: D1Database, env?: WorkerEnv): Promise<void> {
  if (refreshPromise) return refreshPromise;

  const now = Date.now();
  const ttl = platformCache.length > 0 ? CACHE_TTL : EMPTY_CACHE_RETRY;
  if (now - lastRefresh < ttl) return;

  refreshPromise = doRefreshLite(db, env);
  try {
    await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

/**
 * 执行实际的缓存刷新（lite：不查 platform_scores，不同步熔断器）
 */
async function doRefreshLite(db: D1Database, env?: WorkerEnv): Promise<void> {
  const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });

  try {
    const [platformRows, modelMapRows, platformModelRows, autoConfigValue, autoSelectedValue] =
      await Promise.all([
        // 查询启用的平台
        prisma.platforms.findMany({
          where: { enabled: true },
        }),
        // 查询所有模型映射
        prisma.modelMappings.findMany(),
        // 查询平台模型关联（仅启用的模型）
        prisma.platformModels.findMany({
          where: { enabled: true },
          select: {
            platformId: true,
            modelId: true,
          },
        }),
        // 查询自动模型 ID
        getConfig(db, "system:auto_model_id", env),
        // 查询自动模型分流白名单（auto-model 页「参与自动分流」开关）
        getConfig(db, "system:auto_model_selected", env),
      ]);

    const newPlatforms: PlatformConfig[] = platformRows.map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      apiKeys: parseApiKeys(p.apiKeys),
      apiKeyObjects: parseApiKeyObjects(p.apiKeys),
      type: p.type as PlatformConfig["type"],
      enabled: p.enabled,
      priority: p.priority,
      weight: p.weight,
      rpmLimit: p.rpmLimit,
      tpmLimit: p.tpmLimit,
      forwardHeaders: p.forwardHeaders,
      injectStreamOptions: p.injectStreamOptions ?? true,
      // 与全量版 router.ts 一致：缺失时 proxy-lite 的 extraHeaders/UA 覆盖
      // 功能会静默失效（undefined 被当作未配置）
      reuseUserAgent: p.reuseUserAgent ?? false,
      customUserAgent: p.customUserAgent ?? null,
      extraHeaders: p.extraHeaders ?? null,
      status: p.status as PlatformConfig["status"],
      failCount: p.failCount,
      lastFailAt: p.lastFailAt,
      cooldownEnd: p.cooldownEnd,
    }));

    const newModelMaps: ModelMapConfig[] = modelMapRows.map((m) => ({
      id: m.id,
      alias: m.alias,
      targetModel: m.targetModel,
      platformId: m.platformId,
    }));

    // 构建平台模型缓存
    const newPlatformModelCache = new Map<string, Set<string>>();
    for (const pm of platformModelRows) {
      let set = newPlatformModelCache.get(pm.platformId);
      if (!set) {
        set = new Set();
        newPlatformModelCache.set(pm.platformId, set);
      }
      set.add(pm.modelId);
    }

    // 原子赋值
    platformCache = newPlatforms;
    modelMapCache = newModelMaps;
    platformModelCache = newPlatformModelCache;
    autoModelId = autoConfigValue;
    // 解析分流白名单：键不存在 / 非法 JSON / 非数组 → null（全部参与，兼容旧配置）；
    // 显式空数组或全非法元素 → 空集合（无模型参与，fail-closed）
    try {
      const parsed = autoSelectedValue ? JSON.parse(autoSelectedValue) : null;
      if (Array.isArray(parsed)) {
        const filtered = parsed.filter((m): m is string => typeof m === "string");
        autoModelSelected = new Set(filtered);
      } else {
        autoModelSelected = null;
      }
    } catch {
      autoModelSelected = null;
    }
    lastRefresh = Date.now();
  } catch (err) {
    console.error("[router-lite] 缓存刷新失败:", err instanceof Error ? err.message : String(err));
  }
}

/**
 * 强制刷新缓存
 */
export async function forceRefreshRouterCacheLite(
  db: D1Database,
  env?: WorkerEnv
): Promise<void> {
  lastRefresh = 0;
  await refreshCacheLite(db, env);
}

// ==================== 模型映射 ====================

/**
 * 解析模型映射：客户端请求的模型名 → 实际目标模型 + 目标平台
 */
function resolveModelMapping(
  requestedModel: string,
  platformId?: string | null
): { targetModel: string; targetPlatformId: string | null } {
  // 校验模型名称格式
  const MODEL_NAME_PATTERN = /^[a-zA-Z0-9._\-/]{1,200}$/;
  if (!MODEL_NAME_PATTERN.test(requestedModel)) {
    return { targetModel: requestedModel, targetPlatformId: null };
  }

  // 精确匹配
  const exactMatch = modelMapCache.find(
    (m) =>
      m.alias === requestedModel &&
      (platformId ? m.platformId === platformId : true)
  );
  if (exactMatch) {
    return {
      targetModel: exactMatch.targetModel,
      targetPlatformId: exactMatch.platformId,
    };
  }

  // 通配符匹配
  const wildcardMatch = modelMapCache.find(
    (m) =>
      m.alias.endsWith("*") &&
      requestedModel.startsWith(m.alias.slice(0, -1)) &&
      (platformId ? m.platformId === platformId : true)
  );
  if (wildcardMatch) {
    const suffix = requestedModel.slice(wildcardMatch.alias.length - 1);
    return {
      targetModel: wildcardMatch.targetModel + suffix,
      targetPlatformId: wildcardMatch.platformId,
    };
  }

  return { targetModel: requestedModel, targetPlatformId: null };
}

// ==================== 平台选择（纯负载均衡） ====================

/**
 * 按权重加权随机选择平台（lite 专用）
 *
 * 与全量版 selectPlatform 的区别：
 * - 按优先级分组（与全量版一致，仅按权重轮询）
 * - 不读性能评分（不知道评分）
 * - 不检查熔断器状态（不维护熔断器）
 * - 仅被动跳过冷却期内的平台（cooldownEnd 只读）
 */
export function selectPlatformLite(platforms: PlatformConfig[]): PlatformConfig | null {
  const now = Date.now();

  const available = platforms.filter(
    (p) => p.enabled && (p.cooldownEnd === null || p.cooldownEnd * 1000 <= now)
  );
  if (available.length === 0) return null;

  const maxPriority = Math.max(...available.map((p) => p.priority));
  const topPriority = available.filter((p) => p.priority === maxPriority);

  const totalWeight = topPriority.reduce((sum, p) => sum + p.weight, 0);
  if (totalWeight <= 0) return topPriority[0] ?? null;

  let random = Math.random() * totalWeight;
  for (const p of topPriority) {
    random -= p.weight;
    if (random <= 0) return p;
  }
  return topPriority[topPriority.length - 1] ?? null;
}

// ==================== 路由入口 ====================

/**
 * 为请求选择路由（lite：无自动模型冻结、无重试候选逻辑）
 *
 * @param requestedModel - 客户端请求的模型名称
 * @param db - D1 数据库绑定
 * @param sourceApi - 下游来源 API，默认 chat
 * @returns 路由决策（平台 + 目标模型名），无可用平台返回 null
 */
export async function routeRequestLite(
  requestedModel: string,
  db: D1Database,
  env?: WorkerEnv,
  sourceApi: ApiType = "chat"
): Promise<RouteDecision | null> {
  await refreshCacheLite(db, env);

  // 自动模型处理：解析为一个可用平台下的真实模型（lite 不做冻结/解冻）
  if (autoModelId !== null && requestedModel === autoModelId) {
    const eligiblePlatforms: PlatformConfig[] = [];
    const modelByPlatform = new Map<string, string>();
    for (const platform of platformCache) {
      const platformModels = platformModelCache.get(platform.id);
      if (!platformModels) continue;
      for (const modelId of platformModels) {
        if (!autoModelSelected || autoModelSelected.has(modelId)) {
          eligiblePlatforms.push(platform);
          modelByPlatform.set(platform.id, modelId);
          break;
        }
      }
    }

    const autoPlatform = selectPlatformLite(eligiblePlatforms);
    if (!autoPlatform) return null;

    return {
      platform: autoPlatform,
      targetModel: modelByPlatform.get(autoPlatform.id) as string,
      sourceApi,
      targetApi: sourceApi,
      needsConversion: false,
      apiMapping: null,
    };
  }

  // 优先检查接口映射（API 转换）
  let apiMapping: import("./api-mappings").ApiMapping | null = null;
  let targetApi: ApiType = sourceApi;
  let targetModelFromApi: string | null = null;
  let targetPlatformIdFromApi: string | null = null;
  try {
    const apiMappings = await loadApiMappings(db, env);
    const matched = getApplicableApiMapping(apiMappings, requestedModel, sourceApi);
    if (matched) {
      apiMapping = matched;
      targetApi = matched.targetApi;
      targetModelFromApi = resolveApiTargetModel(matched, requestedModel);
      targetPlatformIdFromApi = matched.platformId ?? null;
    }
  } catch (e) {
    console.error("[router-lite] 接口映射加载失败:", e);
  }

  let targetModel: string;
  let targetPlatformId: string | null;
  if (targetModelFromApi) {
    targetModel = targetModelFromApi;
    targetPlatformId = targetPlatformIdFromApi;
  } else {
    const resolved = resolveModelMapping(requestedModel, null);
    targetModel = resolved.targetModel;
    targetPlatformId = resolved.targetPlatformId;
  }
  const needsConversion = apiMapping ? apiMapping.sourceApi !== apiMapping.targetApi : false;

  // 选择平台
  let selectedPlatform: PlatformConfig | null;

  if (targetPlatformId) {
    // 映射指定了平台
    selectedPlatform =
      platformCache.find(
        (p) => p.id === targetPlatformId && p.enabled
      ) ?? null;
  } else {
    // 收集所有支持该模型的平台，按权重负载均衡
    const candidatePlatforms: PlatformConfig[] = [];
    for (const platform of platformCache) {
      const models = platformModelCache.get(platform.id);
      if (models && models.has(targetModel)) {
        candidatePlatforms.push(platform);
      }
    }

    if (candidatePlatforms.length > 0) {
      selectedPlatform = selectPlatformLite(candidatePlatforms);
    } else {
      // 没有任何平台支持该模型（系统中不存在的模型）：不请求上游，直接视为无可用平台
      selectedPlatform = null;
    }
  }

  if (!selectedPlatform) return null;

  return {
    platform: selectedPlatform,
    targetModel,
    sourceApi,
    targetApi,
    needsConversion,
    apiMapping: apiMapping ? { id: apiMapping.id, pattern: apiMapping.pattern } : null,
  };
}

/**
 * 获取当前平台缓存（用于模型列表 API）
 */
export function getPlatformCacheLite(): PlatformConfig[] {
  return platformCache;
}

/**
 * 获取平台模型缓存
 */
export function getPlatformModelCacheLite(): Map<string, Set<string>> {
  return platformModelCache;
}
