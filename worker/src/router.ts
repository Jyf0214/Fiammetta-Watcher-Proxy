/**
 * 路由引擎 — 为请求选择最佳上游平台
 *
 * 核心功能：
 * - 内存缓存平台列表和模型映射，30 秒 TTL
 * - 模型名称解析（精确匹配 + 通配符）
 * - 自动模型支持（配置自动模型 ID 后，所有请求自动路由）
 * - 加权轮询选择平台
 */

import { createDb } from "@/lib/prisma";
import { parseApiKeys, parseApiKeyObjects } from "./platform-keys";
import {
  selectPlatform,
  cleanupStaleBreakers,
  syncCircuitBreakersFromDatabase,
  checkAndUpdateCircuitBreakerState,
  isHighErrorRate,
  isPlatform429Cooldown,
  isHalfOpenProbeFull,
} from "./load-balancer";
import type { PlatformConfig, RouteDecision, ModelMapConfig, ApiType } from "@/lib/types";
import { getConfig } from "./config";
import type { WorkerEnv } from "./config";

// ==================== 缓存 ====================

let platformCache: PlatformConfig[] = [];
let modelMapCache: ModelMapConfig[] = [];
let platformModelCache: Map<string, Set<string>> = new Map();
let autoModelId: string | null = null;
/** 自动模型分流白名单（system:auto_model_selected 配置的模型 ID 集合）；null 表示未配置（全部参与） */
let autoModelSelected: Set<string> | null = null;
let lastRefresh = 0;
/** 路由缓存 TTL：模型映射和平台配置极少变化，延长至 120 秒减少 DB 查询 */
const CACHE_TTL = 120_000;
const EMPTY_CACHE_RETRY = 5_000;

/**
 * 主动失效路由缓存（管理后台保存平台/模型映射/自动模型配置后调用）
 */
export function invalidateRouterCache(): void {
  lastRefresh = 0;
}

// ==================== 自动模型冻结机制 ====================

const frozenModels = new Map<string, number>();
const AUTO_MODEL_FREEZE_MS = 3 * 60 * 1000;

/**
 * 冻结模型（自动模型专用）
 */
export function freezeAutoModel(
  modelName: string,
  durationMs: number = AUTO_MODEL_FREEZE_MS
): void {
  const unfreezeAt = Date.now() + durationMs;
  frozenModels.set(modelName, unfreezeAt);
  console.log(
    `[auto-model] 模型 ${modelName} 已冻结 ${(durationMs / 1000).toFixed(0)} 秒`
  );
}

/**
 * 检查模型是否处于冻结状态
 */
function isAutoModelFrozen(modelName: string): boolean {
  const unfreezeAt = frozenModels.get(modelName);
  if (!unfreezeAt) return false;

  if (Date.now() >= unfreezeAt) {
    frozenModels.delete(modelName);
    console.log(`[auto-model] 模型 ${modelName} 已自动解冻`);
    return false;
  }

  return true;
}

/**
 * 判断请求的模型是否为自动模型
 */
export function isAutoModelRequest(model: string): boolean {
  return autoModelId !== null && model === autoModelId;
}

// ==================== 缓存刷新 ====================

let refreshPromise: Promise<void> | null = null;

/**
 * 刷新平台和模型映射缓存（带防并发穿透锁）
 */
export async function refreshCache(db: D1Database, env?: WorkerEnv): Promise<void> {
  if (refreshPromise) return refreshPromise;

  const now = Date.now();
  const ttl = platformCache.length > 0 ? CACHE_TTL : EMPTY_CACHE_RETRY;
  if (now - lastRefresh < ttl) return;

  refreshPromise = doRefresh(db, env);
  try {
    await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

/**
 * 构建平台模型缓存（仅启用的模型，按平台分组）
 *
 * 启用的过滤由调用方查询条件（enabled: true）保证，此处仅负责分组。
 */
export function buildPlatformModelCache(
  rows: Array<{ platformId: string; modelId: string }>
): Map<string, Set<string>> {
  const cache = new Map<string, Set<string>>();
  for (const pm of rows) {
    let set = cache.get(pm.platformId);
    if (!set) {
      set = new Set();
      cache.set(pm.platformId, set);
    }
    set.add(pm.modelId);
  }
  return cache;
}

/**
 * 执行实际的缓存刷新
 */
async function doRefresh(db: D1Database, env?: WorkerEnv): Promise<void> {
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
    const newPlatformModelCache = buildPlatformModelCache(platformModelRows);

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

    // 清理已删除平台的断路器条目，并从数据库同步熔断器状态
    // （管理后台手动恢复平台后，内存熔断条目在此被清除，避免与库不一致）
    cleanupStaleBreakers(platformRows.map((p) => p.id));
    await syncCircuitBreakersFromDatabase(db, env);
  } catch (err) {
    console.error("[router] 缓存刷新失败:", err instanceof Error ? err.message : String(err));
  }
}

/**
 * 强制刷新缓存
 */
export async function forceRefreshRouterCache(db: D1Database, env?: WorkerEnv): Promise<void> {
  lastRefresh = 0;
  await refreshCache(db, env);
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

// ==================== 路由入口 ====================

/**
 * 为请求选择最佳路由
 *
 * @param requestedModel - 客户端请求的模型名称
 * @param db - D1 数据库绑定
 * @param sourceApi - 下游来源 API（由端点决定），默认 chat 兼容旧调用
 * @returns 路由决策（平台 + 目标模型名），无可用平台返回 null
 */
export async function routeRequest(
  requestedModel: string,
  db: D1Database,
  env?: WorkerEnv,
  sourceApi: ApiType = "chat"
): Promise<RouteDecision | null> {
  await refreshCache(db, env);

  // 自动模型处理（暂不参与 API 转换映射，自动模型本身已是抽象 ID）
  if (autoModelId !== null && requestedModel === autoModelId) {
    const eligiblePlatforms: PlatformConfig[] = [];
    const modelByPlatform = new Map<string, string>();
    for (const platform of platformCache) {
      const platformModels = platformModelCache.get(platform.id);
      if (!platformModels) continue;
      for (const modelId of platformModels) {
        if (!isAutoModelFrozen(modelId) && (!autoModelSelected || autoModelSelected.has(modelId))) {
          eligiblePlatforms.push(platform);
          modelByPlatform.set(platform.id, modelId);
          break;
        }
      }
    }

    const autoPlatform = selectPlatform(eligiblePlatforms);
    if (!autoPlatform) return null;

    return {
      platform: autoPlatform,
      targetModel: modelByPlatform.get(autoPlatform.id) as string,
      sourceApi,
    };
  }

  // 模型映射（别名 → 目标模型）
  const resolved = resolveModelMapping(requestedModel, null);
  const targetModel = resolved.targetModel;
  const targetPlatformId = resolved.targetPlatformId;

  // 选择平台
  let selectedPlatform: PlatformConfig | null;

  if (targetPlatformId) {
    // 映射指定了平台，但仍需检查熔断器状态，避免绕过保护机制
    const candidate = platformCache.find(
      (p) => p.id === targetPlatformId && p.enabled
    ) ?? null;

    if (candidate) {
      const breakerState = checkAndUpdateCircuitBreakerState(candidate.id);
      if (breakerState === "open") {
        // 熔断器打开状态：平台不可用，回退到 selectPlatform 负载均衡
        selectedPlatform = null;
      } else if (breakerState === "half-open" && isHalfOpenProbeFull(candidate.id)) {
        // 半开状态且探测配额已满：不再新开探测，回退到负载均衡
        selectedPlatform = null;
      } else if (isHighErrorRate(candidate.id)) {
        // 高错误率降级：滑动窗口失败率超阈值，回退到负载均衡
        selectedPlatform = null;
      } else if (isPlatform429Cooldown(candidate.id)) {
        // 429 冷却期：平台过载，回退到负载均衡
        selectedPlatform = null;
      } else if (candidate.cooldownEnd !== null && candidate.cooldownEnd * 1000 > Date.now()) {
        // 管理员/系统设置的持久化冷却期未到（库中为 Unix 秒）：与 selectPlatform
        // 的冷却过滤对齐，避免指定路由绕过解禁时间把请求打进已知故障平台
        selectedPlatform = null;
      } else {
        selectedPlatform = candidate;
      }
    } else {
      selectedPlatform = null;
    }
  } else {
    // 收集所有支持该模型的平台，做负载均衡
    // 用 targetModel 匹配：模型映射的别名（如 my-deepseek）不在平台模型缓存中，
    // 缓存里存的是真实上游模型名（如 deepseek-chat），与 429 重试路径 getPlatformsForModel 一致
    const candidatePlatforms: PlatformConfig[] = [];
    for (const platform of platformCache) {
      const models = platformModelCache.get(platform.id);
      if (models && models.has(targetModel)) {
        candidatePlatforms.push(platform);
      }
    }

    if (candidatePlatforms.length > 0) {
      selectedPlatform = selectPlatform(candidatePlatforms);
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
  };
}

/**
 * 获取支持指定模型的平台列表（429 重试用）
 *
 * 返回所有启用且拥有该模型的平台，排除已尝试过的平台。
 */
export function getPlatformsForModel(
  modelId: string,
  excludePlatformIds: Set<string>
): PlatformConfig[] {
  return platformCache.filter((p) => {
    if (excludePlatformIds.has(p.id)) return false;
    if (!p.enabled) return false;
    const models = platformModelCache.get(p.id);
    return models !== undefined && models.has(modelId);
  });
}

/**
 * 获取当前平台缓存（用于模型列表 API）
 */
export function getPlatformCache(): PlatformConfig[] {
  return platformCache;
}

/**
 * 获取平台模型缓存
 */
export function getPlatformModelCache(): Map<string, Set<string>> {
  return platformModelCache;
}
