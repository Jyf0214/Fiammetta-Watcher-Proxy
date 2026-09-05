/**
 * 路由引擎 — 为请求选择最佳上游平台
 *
 * 核心功能：
 * - 内存缓存平台列表，120 秒 TTL
 * - 自动模型支持（配置自动模型 ID 后，所有请求自动路由）
 * - 加权轮询选择平台
 */

import { createDb } from "@/lib/prisma";
import { parseApiKeys, parseApiKeyObjects } from "./platform-keys";
import { resolvePlatformProtocols } from "../../lib/types";
import {
  selectPlatform,
  cleanupStaleBreakers,
  syncCircuitBreakersFromDatabase,
  checkAndUpdateCircuitBreakerState,
} from "./load-balancer";
import type { PlatformConfig, RouteDecision, ApiType } from "@/lib/types";
import { getConfig } from "./config";
import type { WorkerEnv } from "./config";

// ==================== 缓存 ====================

let platformCache: PlatformConfig[] = [];
let platformModelCache: Map<string, Set<string>> = new Map();
let autoModelId: string | null = null;
/** 自动模型分流白名单（system:auto_model_selected 配置的模型 ID 集合）；null 表示未配置（全部参与） */
let autoModelSelected: Set<string> | null = null;
let lastRefresh = 0;
/** 路由缓存 TTL：平台配置极少变化，延长至 120 秒减少 DB 查询 */
const CACHE_TTL = 120_000;
const EMPTY_CACHE_RETRY = 5_000;

/**
 * 主动失效路由缓存（管理后台保存平台/自动模型配置后调用）
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
 * 刷新平台缓存（带防并发穿透锁）
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
    const [platformRows, platformModelRows, autoConfigValue, autoSelectedValue] =
      await Promise.all([
        // 查询启用的平台
        prisma.platforms.findMany({
          where: { enabled: true },
        }),
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
      // 单平台多协议：从 DB 读取 types JSON 字符串并解析为 PlatformProtocol[]。
      // 旧数据（types 列不存在/为空/解析失败）由 resolvePlatformProtocols 回退到 [type]
      types: resolvePlatformProtocols(p.types ?? null, p.type as PlatformConfig["type"]),
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

    // 构建平台模型缓存
    const newPlatformModelCache = buildPlatformModelCache(platformModelRows);

    // 原子赋值
    platformCache = newPlatforms;
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

// ==================== 路由入口 ====================

/**
 * 带半开探测槽位归属标记的路由决策
 *
 * RouteDecision 定义在共享类型文件 lib/types.ts（Pages/Worker 共用，经
 * src/lib/types.ts 桥接导出），此处不改共享定义，以结构扩展方式追加
 * halfOpenHeld 字段；扩展后的类型仍可赋值给任何接受 RouteDecision 的位置。
 */
export interface WorkerRouteDecision extends RouteDecision {
  /**
   * 本次选择是否占用了目标平台的半开探测槽位（halfOpenPending++）。
   *
   * 仅当平台经 selectPlatform 选中、且选中时熔断器处于 half-open 状态时为 true。
   *
   * 调用方约定：请求被 RPM/TPM 门禁拒绝时，仅当此值为 true 才应调用
   * releaseHalfOpenPending —— 否则会误减其他并发探测请求持有的槽位，
   * 使半开期实际并发探测超过上限（bug L5）。
   */
  halfOpenHeld?: boolean;
}

/**
 * 判断刚被 selectPlatform 选中的平台是否在选中时占用了半开探测槽位
 *
 * selectPlatform 内部仅在「选中且当时熔断器为 half-open」时执行
 * halfOpenPending++。本函数必须在同一同步块内紧随 selectPlatform 调用：
 * 中间无 await、状态不可能被其他请求改写（Workers 单线程），读取结果与
 * 占用条件完全一致；且刚通过过滤的平台不可能处于 open 态（open→half-open
 * 的转换只发生在 selectPlatform 的过滤阶段），此时
 * checkAndUpdateCircuitBreakerState 对 closed/half-open 均为纯读。
 */
function heldHalfOpenSlot(platformId: string): boolean {
  return checkAndUpdateCircuitBreakerState(platformId) === "half-open";
}

/**
 * 为请求选择最佳路由
 *
 * @param requestedModel - 客户端请求的模型名称
 * @param db - D1 数据库绑定
 * @param sourceApi - 下游来源 API（由端点决定），默认 chat 兼容旧调用
 * @returns 路由决策（平台 + 目标模型名），无可用平台返回 null；
 *          halfOpenHeld 标记本次选择是否占用了半开探测槽位，语义见 WorkerRouteDecision
 */
export async function routeRequest(
  requestedModel: string,
  db: D1Database,
  env?: WorkerEnv,
  sourceApi: ApiType = "chat"
): Promise<WorkerRouteDecision | null> {
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
      halfOpenHeld: heldHalfOpenSlot(autoPlatform.id),
    };
  }

  // 选择平台：按客户端请求的模型名匹配所有支持的平台，做负载均衡
  let selectedPlatform: PlatformConfig | null;
  // 本次选择是否经 selectPlatform 占用了半开探测槽位
  let halfOpenHeld = false;

  const candidatePlatforms: PlatformConfig[] = [];
  for (const platform of platformCache) {
    const models = platformModelCache.get(platform.id);
    if (models && models.has(requestedModel)) {
      candidatePlatforms.push(platform);
    }
  }

  if (candidatePlatforms.length > 0) {
    selectedPlatform = selectPlatform(candidatePlatforms);
    // 必须紧随 selectPlatform 同步调用（无 await 间隔），见 heldHalfOpenSlot 注释
    halfOpenHeld =
      selectedPlatform !== null && heldHalfOpenSlot(selectedPlatform.id);
  } else {
    // 没有任何平台支持该模型（系统中不存在的模型）：不请求上游，直接视为无可用平台
    selectedPlatform = null;
  }

  if (!selectedPlatform) return null;

  return {
    platform: selectedPlatform,
    targetModel: requestedModel,
    sourceApi,
    halfOpenHeld,
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
