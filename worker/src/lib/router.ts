/**
 * 请求路由模块 — 选择最佳上游平台处理请求
 *
 * 从 D1 查询平台和模型映射（替代 Prisma 查询），
 * 使用 KV 缓存（替代内存 Map），TTL 30 秒。
 *
 * 核心逻辑：
 * 1. 模型映射：客户端请求的模型名 → 实际目标模型 + 目标平台
 * 2. 自动模型：请求模型 === 配置的自动模型 ID 时，自动选择最佳平台和模型
 * 3. 平台选择：按优先级分组 → 组内加权随机
 * 4. 熔断器集成：open 状态平台不参与路由，half-open 状态限制并发探测
 */

import type { Env } from "../types";
import { createDb } from "../db";
import { platforms, modelMaps, platformModels, configs } from "../db/schema";
import { eq, asc } from "drizzle-orm";
import { parseApiKeys } from "./platform-keys";
import {
  checkAndUpdateCircuitBreakerState,
  getCircuitBreakerState,
  incrementHalfOpenPending,
  syncFromDatabase,
} from "./circuit-breaker";
import { validateUrlSafe } from "./url-validation";

// ==================== 路由类型 ====================
// Worker 版本中类型定义在本模块内，避免修改 types.ts

export type PlatformType = "openai" | "azure" | "custom";
export type PlatformStatus = "healthy" | "degraded" | "down";

/** 平台配置（路由使用） */
export interface PlatformConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  apiKeys: string[];
  type: PlatformType;
  enabled: boolean;
  priority: number;
  weight: number;
  rpmLimit: number | null;
  tpmLimit: number | null;
  forwardHeaders: string;
  status: PlatformStatus;
  failCount: number;
  lastFailAt: Date | null;
  cooldownEnd: Date | null;
}

/** 路由决策结果 */
export interface RouteDecision {
  platform: PlatformConfig;
  targetModel: string;
}

/** 模型映射配置 */
export interface ModelMapConfig {
  id: string;
  alias: string;
  targetModel: string;
  platformId: string | null;
}

// ==================== 缓存配置 ====================

/**
 * 校验平台 baseUrl 是否安全（SSRF 防护）
 *
 * 静态检查：拦截内网地址、localhost 变体等。
 * 数据库中的 baseUrl 应在写入时已校验，此处为防御性二次校验，
 * 防止数据库被直接修改绕过管理端校验。
 */
function isPlatformBaseUrlSafe(platform: PlatformConfig): boolean {
  return validateUrlSafe(platform.baseUrl).valid;
}

/** 平台模型缓存的 KV key */
const PLATFORM_MODELS_CACHE_KEY = "platform_models";

/** 缓存 TTL：30 秒 */
const CACHE_TTL_MS = 30_000;

/** 空缓存时的重试间隔（避免频繁查询） */
const EMPTY_CACHE_RETRY_MS = 5_000;

// ==================== 内存缓存 ====================
// KV 缓存用于跨 Worker 实例共享，内存缓存用于单实例内减少 KV 读取延迟

let platformCache: PlatformConfig[] = [];
let modelMapCache: ModelMapConfig[] = [];
let platformModelCache: Map<string, Set<string>> = new Map();
let autoModelId: string | null = null;
let lastRefresh = 0;
let refreshPromise: Promise<void> | null = null;

// ==================== 自动模型冻结机制 ====================
// 当自动模型请求某模型失败（429/错误）时，临时冻结该模型，
// 冻结期间自动模型不会再次选择该模型，到期后自动解冻。

const frozenModels = new Map<string, number>(); // modelName → 解冻时间戳
const AUTO_MODEL_FREEZE_MS = 3 * 60 * 1000; // 默认冻结 3 分钟

/**
 * 冻结模型（自动模型专用）
 *
 * 冻结期间，自动模型路由不会选择该模型。
 * 冻结到期后自动解冻，无需手动干预。
 */
export function freezeAutoModel(
  _env: Env,
  modelName: string,
  durationMs: number = AUTO_MODEL_FREEZE_MS
): void {
  const unfreezeAt = Date.now() + durationMs;
  frozenModels.set(modelName, unfreezeAt);
  console.log(
    `[auto-model] 模型 ${modelName} 已冻结 ${(durationMs / 1000).toFixed(0)} 秒，解冻时间: ${new Date(unfreezeAt).toISOString()}`
  );
}

/**
 * 检查模型是否处于冻结状态（自动模型专用）
 */
function isAutoModelFrozen(modelName: string): boolean {
  const unfreezeAt = frozenModels.get(modelName);
  if (!unfreezeAt) return false;

  if (Date.now() >= unfreezeAt) {
    // 已到期，自动解冻
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

/**
 * 刷新平台和模型映射缓存（带防并发穿透锁）
 *
 * 多个并发请求同时触发刷新时，只有第一个会真正执行数据库查询，
 * 其余请求复用同一个 Promise，避免惊群效应。
 */
async function refreshCache(env: Env): Promise<void> {
  if (refreshPromise) return refreshPromise;

  const now = Date.now();
  const ttl = platformCache.length > 0 ? CACHE_TTL_MS : EMPTY_CACHE_RETRY_MS;
  if (now - lastRefresh < ttl) return;

  refreshPromise = doRefresh(env);
  try {
    await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

/**
 * 执行实际的缓存刷新（D1 查询 + KV 缓存 + 原子赋值）
 */
async function doRefresh(env: Env): Promise<void> {
  const db = createDb(env.DB);

  // 并行查询 D1 + KV
  const [platformRows, modelMapRows, platformModelRows, autoConfig] = await Promise.all([
    // 查询已启用的平台，按优先级和权重降序
    db.select().from(platforms)
      .where(eq(platforms.enabled, true))
      .orderBy(asc(platforms.priority), asc(platforms.weight))
      .then((rows) => rows.reverse()), // Drizzle asc + reverse = desc
    // 查询所有模型映射
    db.select().from(modelMaps),
    // 查询平台模型关联
    db.select({
      platformId: platformModels.platformId,
      modelId: platformModels.modelId,
    }).from(platformModels),
    // 查询自动模型 ID
    db.select().from(configs)
      .where(eq(configs.key, "system:auto_model_id"))
      .then((rows) => rows[0] ?? null),
  ]);

  // 构建平台缓存
  const newPlatforms: PlatformConfig[] = platformRows.map((p) => ({
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    apiKeys: parseApiKeys(p.apiKeys),
    type: (p.type ?? "openai") as PlatformConfig["type"],
    enabled: p.enabled ?? true,
    priority: p.priority ?? 0,
    weight: p.weight ?? 1,
    rpmLimit: p.rpmLimit,
    tpmLimit: p.tpmLimit,
    forwardHeaders: p.forwardHeaders ?? "[]",
    status: (p.status ?? "healthy") as PlatformConfig["status"],
    failCount: p.failCount ?? 0,
    lastFailAt: p.lastFailAt ? new Date(p.lastFailAt) : null,
    cooldownEnd: p.cooldownEnd ? new Date(p.cooldownEnd) : null,
  }));

  // 构建模型映射缓存
  const newModelMaps: ModelMapConfig[] = modelMapRows.map((m) => ({
    id: m.id,
    alias: m.alias,
    targetModel: m.targetModel,
    platformId: m.platformId,
  }));

  // 构建平台模型缓存：platformId → Set<modelId>
  const newPlatformModelCache = new Map<string, Set<string>>();
  for (const pm of platformModelRows) {
    let set = newPlatformModelCache.get(pm.platformId);
    if (!set) {
      set = new Set();
      newPlatformModelCache.set(pm.platformId, set);
    }
    set.add(pm.modelId);
  }

  // 原子赋值：所有缓存同时切换，避免读取方看到不一致的状态
  platformCache = newPlatforms;
  modelMapCache = newModelMaps;
  platformModelCache = newPlatformModelCache;
  autoModelId = autoConfig?.value ?? null;
  lastRefresh = Date.now();

  // 异步写入 KV 缓存（不阻塞主流程）
  const platformModelsObj: Record<string, string[]> = {};
  for (const [pid, models] of newPlatformModelCache) {
    platformModelsObj[pid] = Array.from(models);
  }
  env.KV.put(PLATFORM_MODELS_CACHE_KEY, JSON.stringify(platformModelsObj), {
    expirationTtl: 60,
  }).catch(() => {});
}

/**
 * 强制刷新缓存（在平台/模型映射变更后调用）
 */
export async function forceRefreshRouterCache(env: Env): Promise<void> {
  lastRefresh = 0;
  await refreshCache(env);
}

/**
 * 解析模型映射：客户端请求的模型名 → 实际目标模型 + 目标平台
 */
function resolveModelMapping(
  requestedModel: string,
  platformId?: string | null
): { targetModel: string; targetPlatformId: string | null } {
  // 校验模型名称格式：仅允许字母、数字、点、下划线、短横线、斜杠，最长 200 字符
  const MODEL_NAME_PATTERN = /^[a-zA-Z0-9._\-/]{1,200}$/;
  if (!MODEL_NAME_PATTERN.test(requestedModel)) {
    return { targetModel: requestedModel, targetPlatformId: null };
  }

  // 精确匹配：模型名 + 平台绑定
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

  // 通配符匹配：以 * 结尾的映射规则，同时按 platformId 过滤
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

  // 无映射：原样传递
  return { targetModel: requestedModel, targetPlatformId: null };
}

/**
 * 按权重选择平台（加权随机）
 */
function selectPlatformByWeight(
  platformsList: PlatformConfig[]
): PlatformConfig | null {
  if (platformsList.length === 0) return null;

  const totalWeight = platformsList.reduce((sum, p) => sum + p.weight, 0);
  if (totalWeight === 0) return platformsList[0];

  let random = Math.random() * totalWeight;
  for (const platform of platformsList) {
    random -= platform.weight;
    if (random <= 0) return platform;
  }

  return platformsList[platformsList.length - 1];
}

/**
 * 按平台权重选择候选模型（加权随机，权重来自所属平台）
 */
function selectCandidateByWeight(
  candidates: { platform: PlatformConfig; model: string }[]
): { platform: PlatformConfig; model: string } | null {
  if (candidates.length === 0) return null;

  const totalWeight = candidates.reduce((sum, c) => sum + c.platform.weight, 0);
  if (totalWeight === 0) return candidates[0];

  let random = Math.random() * totalWeight;
  for (const candidate of candidates) {
    random -= candidate.platform.weight;
    if (random <= 0) return candidate;
  }

  return candidates[candidates.length - 1];
}

/**
 * 检查平台是否可用（纯查询，无副作用）
 *
 * 仅读取熔断器状态，不触发状态转换，不递增半开探测计数。
 * 展示、统计等场景可安全调用。
 */
async function isPlatformAvailable(env: Env, platform: PlatformConfig): Promise<boolean> {
  if (!platform.enabled) return false;

  // SSRF 防护：baseUrl 指向内网地址的平台不可用
  if (!isPlatformBaseUrlSafe(platform)) {
    console.warn(`[ssrf] 平台 ${platform.name} (${platform.id}) 的 baseUrl 指向内网地址，已跳过`);
    return false;
  }

  // 读取熔断器状态（纯查询，不触发 open → half-open 转换）
  const breakerState = await getCircuitBreakerState(env, platform.id);

  // 熔断器处于 open 状态，平台不可用
  if (breakerState === "open") return false;

  // 熔断器处于 half-open 或 closed 状态，检查冷却期
  if (platform.cooldownEnd && platform.cooldownEnd > new Date()) return false;
  return true;
}

/**
 * 刷新所有平台的熔断器状态（触发 open → half-open 自然转换）
 *
 * 在路由决策前调用一次，将冷却期已过的 open 状态平台转为 half-open。
 */
async function refreshCircuitBreakerStates(env: Env, platformsList: PlatformConfig[]): Promise<void> {
  for (const p of platformsList) {
    if (!p.enabled) continue;
    await checkAndUpdateCircuitBreakerState(env, p.id);
  }
}

/**
 * 检查平台是否拥有指定模型
 *
 * 如果 platformModelCache 为空（未拉取过模型），视为兼容模式，不过滤。
 */
function hasPlatformModel(platformId: string, modelId: string): boolean {
  // 兼容模式：无模型数据时不过滤
  if (platformModelCache.size === 0) return true;

  const models = platformModelCache.get(platformId);
  if (!models) return false;

  // 精确匹配
  if (models.has(modelId)) return true;

  // 通配符匹配：平台拥有 gpt-* 类模型时匹配 gpt-4o 等
  for (const m of models) {
    if (m.endsWith("*") && modelId.startsWith(m.slice(0, -1))) return true;
  }

  return false;
}

/**
 * 选择最佳平台处理请求
 *
 * @param env Cloudflare 环境绑定（包含 DB、KV）
 * @param requestedModel 客户端请求的模型名
 * @param specifiedPlatformId 可选，客户端指定的平台 ID
 * @returns 路由决策（平台 + 目标模型），无可用平台返回 null
 */
export async function routeRequest(
  env: Env,
  requestedModel: string,
  specifiedPlatformId?: string
): Promise<RouteDecision | null> {
  await refreshCache(env);

  // 首次路由请求时从 D1 同步熔断器状态到 KV（Worker 重启后恢复状态）
  await syncFromDatabase(env);

  // 统一触发熔断器 open → half-open 转换（仅执行一次，不重复）
  await refreshCircuitBreakerStates(env, platformCache);

  // 自动模型路由：请求模型 === 配置的自动模型 ID
  if (autoModelId && requestedModel === autoModelId) {
    // 收集所有可用平台上未冻结的模型，构建 (平台, 模型) 候选列表
    const candidates: { platform: PlatformConfig; model: string }[] = [];

    for (const p of platformCache) {
      if (!(await isPlatformAvailable(env, p))) continue;
      const models = platformModelCache.get(p.id);
      if (!models || models.size === 0) continue;

      for (const modelName of models) {
        // 跳过冻结中的模型
        if (isAutoModelFrozen(modelName)) continue;
        // 跳过通配符规则（如 gpt-*），只选择具体模型
        if (modelName.includes("*")) continue;
        candidates.push({ platform: p, model: modelName });
      }
    }

    if (candidates.length === 0) return null;

    // 按平台优先级分组，选择最高优先级组
    const maxPriority = Math.max(...candidates.map((c) => c.platform.priority));
    const topPriority = candidates.filter((c) => c.platform.priority === maxPriority);

    // 在最高优先级组中，按平台权重加权随机选择一个 (平台, 模型) 对
    const selected = selectCandidateByWeight(topPriority);
    if (!selected) return null;

    // 仅对选中的平台递增半开探测计数
    const breakerState = await getCircuitBreakerState(env, selected.platform.id);
    if (breakerState === "half-open") {
      await incrementHalfOpenPending(env, selected.platform.id);
    }
    return { platform: selected.platform, targetModel: selected.model };
  }

  const { targetModel, targetPlatformId } = resolveModelMapping(
    requestedModel,
    specifiedPlatformId
  );

  // 如果模型映射指定了平台（用户明确绑定，优先使用）
  if (targetPlatformId) {
    const platform = platformCache.find(
      (p) =>
        p.id === targetPlatformId &&
        hasPlatformModel(p.id, targetModel)
    );
    if (platform && await isPlatformAvailable(env, platform)) {
      const breakerState = await getCircuitBreakerState(env, platform.id);
      if (breakerState === "half-open") {
        await incrementHalfOpenPending(env, platform.id);
      }
      return { platform, targetModel };
    }
    // 指定平台不可用或无该模型，尝试其他平台
  }

  // 按优先级和权重选择可用平台，且平台必须拥有目标模型
  const availablePlatforms: PlatformConfig[] = [];
  for (const p of platformCache) {
    if (await isPlatformAvailable(env, p) && hasPlatformModel(p.id, targetModel)) {
      availablePlatforms.push(p);
    }
  }

  if (availablePlatforms.length === 0) {
    // fallback：无平台拥有该模型时，不过滤模型（兼容未拉取过模型的场景）
    const fallbackPlatforms: PlatformConfig[] = [];
    for (const p of platformCache) {
      if (await isPlatformAvailable(env, p)) {
        fallbackPlatforms.push(p);
      }
    }
    if (fallbackPlatforms.length === 0) return null;

    const maxPriority = Math.max(...fallbackPlatforms.map((p) => p.priority));
    const topPriorityPlatforms = fallbackPlatforms.filter(
      (p) => p.priority === maxPriority
    );

    const selectedPlatform = selectPlatformByWeight(topPriorityPlatforms);
    if (!selectedPlatform) return null;

    const breakerState = await getCircuitBreakerState(env, selectedPlatform.id);
    if (breakerState === "half-open") {
      await incrementHalfOpenPending(env, selectedPlatform.id);
    }
    return { platform: selectedPlatform, targetModel };
  }

  // 按优先级分组
  const maxPriority = Math.max(...availablePlatforms.map((p) => p.priority));
  const topPriorityPlatforms = availablePlatforms.filter(
    (p) => p.priority === maxPriority
  );

  const selectedPlatform = selectPlatformByWeight(topPriorityPlatforms);
  if (!selectedPlatform) return null;

  const breakerState = await getCircuitBreakerState(env, selectedPlatform.id);
  if (breakerState === "half-open") {
    await incrementHalfOpenPending(env, selectedPlatform.id);
  }

  return {
    platform: selectedPlatform,
    targetModel,
  };
}

/**
 * 按平台 ID 直接路由（客户端指定平台）
 */
export async function routeToPlatform(
  env: Env,
  platformId: string
): Promise<PlatformConfig | null> {
  await refreshCache(env);

  // 触发该平台的熔断器状态转换
  await checkAndUpdateCircuitBreakerState(env, platformId);

  const platform = platformCache.find(
    (p) => p.id === platformId
  );
  if (platform && await isPlatformAvailable(env, platform)) {
    const breakerState = await getCircuitBreakerState(env, platform.id);
    if (breakerState === "half-open") {
      await incrementHalfOpenPending(env, platform.id);
    }
    return platform;
  }
  return null;
}

/**
 * 获取所有可用平台列表
 */
export async function getAvailablePlatforms(env: Env): Promise<PlatformConfig[]> {
  await refreshCache(env);
  const result: PlatformConfig[] = [];
  for (const p of platformCache) {
    if (await isPlatformAvailable(env, p)) {
      result.push(p);
    }
  }
  return result;
}
