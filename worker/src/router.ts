/**
 * 路由引擎 — 为请求选择最佳上游平台
 *
 * 核心功能：
 * - 内存缓存平台列表和模型映射，30 秒 TTL
 * - 模型名称解析（精确匹配 + 通配符）
 * - 自动模型支持（配置自动模型 ID 后，所有请求自动路由）
 * - 加权轮询选择平台
 */

import { eq } from "drizzle-orm";
import { createDb } from "@/lib/db";
import * as schema from "@/lib/schema";
import { parseApiKeys } from "./platform-keys";
import { selectPlatform, cleanupStaleBreakers } from "./load-balancer";
import type { PlatformConfig, RouteDecision, ModelMapConfig } from "@/lib/types";
import { getConfig } from "./config";

// ==================== 缓存 ====================

let platformCache: PlatformConfig[] = [];
let modelMapCache: ModelMapConfig[] = [];
let platformModelCache: Map<string, Set<string>> = new Map();
let autoModelId: string | null = null;
let lastRefresh = 0;
const CACHE_TTL = 30_000;
const EMPTY_CACHE_RETRY = 5_000;

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
export async function refreshCache(db: D1Database): Promise<void> {
  if (refreshPromise) return refreshPromise;

  const now = Date.now();
  const ttl = platformCache.length > 0 ? CACHE_TTL : EMPTY_CACHE_RETRY;
  if (now - lastRefresh < ttl) return;

  refreshPromise = doRefresh(db);
  try {
    await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

/**
 * 执行实际的缓存刷新
 */
async function doRefresh(db: D1Database): Promise<void> {
  const orm = await createDb(db);

  const [platformRows, modelMapRows, platformModelRows, autoConfigValue] =
    await Promise.all([
      // 查询启用的平台
      orm
        .select()
        .from(schema.platforms)
        .where(eq(schema.platforms.enabled, true)),
      // 查询所有模型映射
      orm.select().from(schema.modelMappings),
      // 查询平台模型关联（仅启用的模型）
      orm
        .select({
          platformId: schema.platformModels.platformId,
          modelId: schema.platformModels.modelId,
        })
        .from(schema.platformModels)
        .where(eq(schema.platformModels.enabled, true)),
      // 查询自动模型 ID
      getConfig(db, "system:auto_model_id"),
    ]);

  const newPlatforms: PlatformConfig[] = platformRows.map((p) => ({
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    apiKeys: parseApiKeys(p.apiKeys),
    type: p.type as PlatformConfig["type"],
    enabled: p.enabled,
    priority: p.priority,
    weight: p.weight,
    rpmLimit: p.rpmLimit,
    tpmLimit: p.tpmLimit,
    forwardHeaders: p.forwardHeaders,
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
  lastRefresh = Date.now();

  // 清理已删除平台的断路器条目
  cleanupStaleBreakers(platformRows.map((p) => p.id));
}

/**
 * 强制刷新缓存
 */
export async function forceRefreshRouterCache(db: D1Database): Promise<void> {
  lastRefresh = 0;
  await refreshCache(db);
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
 * @returns 路由决策（平台 + 目标模型名），无可用平台返回 null
 */
export async function routeRequest(
  requestedModel: string,
  db: D1Database
): Promise<RouteDecision | null> {
  await refreshCache(db);

  // 自动模型处理
  let actualModel = requestedModel;
  if (autoModelId !== null && requestedModel === autoModelId) {
    // 自动模型：选择第一个可用平台的一个模型
    const autoPlatform = selectPlatform(platformCache);
    if (!autoPlatform) return null;

    // 从平台模型缓存中选择一个未冻结的模型
    const platformModels = platformModelCache.get(autoPlatform.id);
    if (platformModels) {
      for (const modelId of platformModels) {
        if (!isAutoModelFrozen(modelId)) {
          actualModel = modelId;
          break;
        }
      }
    }
    // 如果没找到可用模型，使用默认
    if (actualModel === autoModelId) {
      return null;
    }

    return { platform: autoPlatform, targetModel: actualModel };
  }

  // 普通模型：解析映射
  const { targetModel, targetPlatformId } = resolveModelMapping(
    requestedModel,
    null
  );

  // 选择平台
  let selectedPlatform: PlatformConfig | null = null;

  if (targetPlatformId) {
    // 映射指定了平台
    selectedPlatform =
      platformCache.find(
        (p) => p.id === targetPlatformId && p.enabled
      ) ?? null;
  } else {
    // 自由选择
    // 先检查模型是否被某个平台直接支持
    for (const platform of platformCache) {
      const models = platformModelCache.get(platform.id);
      if (models && models.has(requestedModel)) {
        selectedPlatform = platform;
        break;
      }
    }

    // 没有直接支持的平台，使用加权轮询
    if (!selectedPlatform) {
      selectedPlatform = selectPlatform(platformCache);
    }
  }

  if (!selectedPlatform) return null;

  return { platform: selectedPlatform, targetModel };
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
