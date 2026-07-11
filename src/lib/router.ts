import { prisma } from "./prisma";
import { checkAndUpdateCircuitBreakerState, getCircuitBreakerState, incrementHalfOpenPending, cleanupStaleBreakers } from "./circuit-breaker";
import { parseApiKeys } from "./platform-keys";
import type { PlatformConfig, RouteDecision, ModelMapConfig } from "@/types";

// 内存缓存，避免每次请求都查数据库
let platformCache: PlatformConfig[] = [];
let modelMapCache: ModelMapConfig[] = [];
let platformModelCache: Map<string, Set<string>> = new Map(); // platformId → 模型 ID 集合
let autoModelId: string | null = null; // 自动模型 ID（从 Config 表读取）
let lastRefresh = 0;
const CACHE_TTL = 30_000;
const EMPTY_CACHE_RETRY = 5_000; // 空缓存时的重试间隔

// ==================== 自动模型冻结机制 ====================
// 当自动模型请求某模型失败（429/错误）时，临时冻结该模型，
// 冻结期间自动模型不会再次选择该模型，到期后自动解冻。
// 同一平台的其他模型不受影响。

const frozenModels = new Map<string, number>(); // modelName → 解冻时间戳
const AUTO_MODEL_FREEZE_MS = 3 * 60 * 1000; // 默认冻结 3 分钟

/**
 * 冻结模型（自动模型专用）
 *
 * 冻结期间，自动模型路由不会选择该模型。
 * 冻结到期后自动解冻，无需手动干预。
 */
export function freezeAutoModel(
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

let refreshPromise: Promise<void> | null = null;

/**
 * 刷新平台和模型映射缓存（带防并发穿透锁）
 *
 * 多个并发请求同时触发刷新时，只有第一个会真正执行数据库查询，
 * 其余请求复用同一个 Promise，避免惊群效应。
 */
async function refreshCache() {
  if (refreshPromise) return refreshPromise;

  const now = Date.now();
  const ttl = platformCache.length > 0 ? CACHE_TTL : EMPTY_CACHE_RETRY;
  if (now - lastRefresh < ttl) return;

  refreshPromise = doRefresh();
  try {
    await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

/**
 * 执行实际的缓存刷新（数据库查询 + 原子赋值）
 */
async function doRefresh() {
  const [platforms, modelMaps, platformModels, autoConfig] = await Promise.all([
    prisma.platform.findMany({
      where: { enabled: true },
      orderBy: [{ priority: "desc" }, { weight: "desc" }],
    }),
    prisma.modelMap.findMany(),
    prisma.platformModel.findMany({
      select: { platformId: true, modelId: true },
    }),
    prisma.config.findUnique({ where: { key: "system:auto_model_id" } }),
  ]);

  const newPlatforms = platforms.map((p) => ({
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

  const newModelMaps = modelMaps.map((m) => ({
    id: m.id,
    alias: m.alias,
    targetModel: m.targetModel,
    platformId: m.platformId,
  }));

  // 构建平台模型缓存：platformId → Set<modelId>
  const newPlatformModelCache = new Map<string, Set<string>>();
  for (const pm of platformModels) {
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

  // 清理已删除平台的断路器条目
  cleanupStaleBreakers(platforms.map(p => p.id));
}

/**
 * 强制刷新缓存（在平台/模型映射变更后调用）
 */
export async function forceRefreshRouterCache() {
  lastRefresh = 0;
  await refreshCache();
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
  platforms: PlatformConfig[]
): PlatformConfig | null {
  if (platforms.length === 0) return null;

  const totalWeight = platforms.reduce((sum, p) => sum + p.weight, 0);
  if (totalWeight === 0) return platforms[0];

  let random = Math.random() * totalWeight;
  for (const platform of platforms) {
    random -= platform.weight;
    if (random <= 0) return platform;
  }

  return platforms[platforms.length - 1];
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
function isPlatformAvailable(platform: PlatformConfig): boolean {
  if (!platform.enabled) return false;

  // 读取熔断器状态（纯查询，不触发 open → half-open 转换）
  const breakerState = getCircuitBreakerState(platform.id);

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
 * 与 isPlatformAvailable 分离，避免每次查询都触发副作用。
 */
function refreshCircuitBreakerStates(platforms: PlatformConfig[]): void {
  for (const p of platforms) {
    if (!p.enabled) continue;
    checkAndUpdateCircuitBreakerState(p.id);
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
 */
export async function routeRequest(
  requestedModel: string,
  specifiedPlatformId?: string
): Promise<RouteDecision | null> {
  await refreshCache();

  // 统一触发熔断器 open → half-open 转换（仅执行一次，不重复）
  refreshCircuitBreakerStates(platformCache);

  // 自动模型路由：请求模型 === 配置的自动模型 ID
  if (autoModelId && requestedModel === autoModelId) {
    // 收集所有可用平台上未冻结的模型，构建 (平台, 模型) 候选列表
    const candidates: { platform: PlatformConfig; model: string }[] = [];

    for (const p of platformCache) {
      if (!isPlatformAvailable(p)) continue;
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
    const breakerState = getCircuitBreakerState(selected.platform.id);
    if (breakerState === "half-open") {
      incrementHalfOpenPending(selected.platform.id);
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
        isPlatformAvailable(p) &&
        hasPlatformModel(p.id, targetModel)
    );
    if (platform) {
      const breakerState = getCircuitBreakerState(platform.id);
      if (breakerState === "half-open") {
        incrementHalfOpenPending(platform.id);
      }
      return { platform, targetModel };
    }
    // 指定平台不可用或无该模型，尝试其他平台
  }

  // 按优先级和权重选择可用平台，且平台必须拥有目标模型
  const availablePlatforms = platformCache.filter(
    (p) => isPlatformAvailable(p) && hasPlatformModel(p.id, targetModel)
  );

  if (availablePlatforms.length === 0) {
    // fallback：无平台拥有该模型时，不过滤模型（兼容未拉取过模型的场景）
    const fallbackPlatforms = platformCache.filter(isPlatformAvailable);
    if (fallbackPlatforms.length === 0) return null;

    const maxPriority = Math.max(...fallbackPlatforms.map((p) => p.priority));
    const topPriorityPlatforms = fallbackPlatforms.filter(
      (p) => p.priority === maxPriority
    );

    const selectedPlatform = selectPlatformByWeight(topPriorityPlatforms);
    if (!selectedPlatform) return null;

    const breakerState = getCircuitBreakerState(selectedPlatform.id);
    if (breakerState === "half-open") {
      incrementHalfOpenPending(selectedPlatform.id);
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

  const breakerState = getCircuitBreakerState(selectedPlatform.id);
  if (breakerState === "half-open") {
    incrementHalfOpenPending(selectedPlatform.id);
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
  platformId: string
): Promise<PlatformConfig | null> {
  await refreshCache();

  // 触发该平台的熔断器状态转换
  checkAndUpdateCircuitBreakerState(platformId);

  const platform = platformCache.find(
    (p) => p.id === platformId && isPlatformAvailable(p)
  );
  if (platform) {
    const breakerState = getCircuitBreakerState(platform.id);
    if (breakerState === "half-open") {
      incrementHalfOpenPending(platform.id);
    }
  }
  return platform ?? null;
}

/**
 * 获取所有可用平台列表
 */
export async function getAvailablePlatforms(): Promise<PlatformConfig[]> {
  await refreshCache();
  return platformCache.filter(isPlatformAvailable);
}
