import { prisma } from "./prisma";
import { checkAndUpdateCircuitBreakerState, incrementHalfOpenPending, cleanupStaleBreakers } from "./circuit-breaker";
import type { PlatformConfig, RouteDecision, ModelMapConfig } from "@/types";

// 内存缓存，避免每次请求都查数据库
let platformCache: PlatformConfig[] = [];
let modelMapCache: ModelMapConfig[] = [];
let lastRefresh = 0;
const CACHE_TTL = 30_000;
const EMPTY_CACHE_RETRY = 5_000; // 空缓存时的重试间隔

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
  const [platforms, modelMaps] = await Promise.all([
    prisma.platform.findMany({
      where: { enabled: true },
      orderBy: [{ priority: "desc" }, { weight: "desc" }],
    }),
    prisma.modelMap.findMany(),
  ]);

  const newPlatforms = platforms.map((p) => ({
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    type: p.type as PlatformConfig["type"],
    enabled: p.enabled,
    priority: p.priority,
    weight: p.weight,
    rpmLimit: p.rpmLimit,
    tpmLimit: p.tpmLimit,
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

  // 原子赋值：两个缓存同时切换，避免读取方看到不一致的状态
  platformCache = newPlatforms;
  modelMapCache = newModelMaps;
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
 * 检查平台是否可用（未处于熔断冷却期）
 *
 * 通过调用 checkAndUpdateCircuitBreakerState 触发 open → half-open 的自动转换，
 * 使得冷却期过后的熔断器能进入探测阶段。
 */
function isPlatformAvailable(platform: PlatformConfig): boolean {
  if (!platform.enabled) return false;

  // 检查内存中的熔断器状态，触发 open → half-open 的自动转换
  const breakerState = checkAndUpdateCircuitBreakerState(platform.id);

  // 熔断器处于 open 状态且冷却期未过，平台不可用
  if (breakerState === "open") return false;

  // 熔断器处于 half-open 状态，允许探测请求通过
  if (breakerState === "half-open") {
    incrementHalfOpenPending(platform.id);
    return true;
  }

  if (breakerState === "closed") {
    // 断路器认为已恢复，以内存状态为准
    // 不再检查缓存中的 status（可能因 DB 更新失败而过时）
    if (platform.cooldownEnd && platform.cooldownEnd > new Date()) return false;
    return true;
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

  const { targetModel, targetPlatformId } = resolveModelMapping(
    requestedModel,
    specifiedPlatformId
  );

  // 如果模型映射指定了平台
  if (targetPlatformId) {
    const platform = platformCache.find(
      (p) => p.id === targetPlatformId && isPlatformAvailable(p)
    );
    if (platform) {
      return { platform, targetModel };
    }
    // 指定平台不可用，尝试其他平台
  }

  // 按优先级和权重选择可用平台
  const availablePlatforms = platformCache.filter(isPlatformAvailable);

  if (availablePlatforms.length === 0) return null;

  // 按优先级分组
  const maxPriority = Math.max(...availablePlatforms.map((p) => p.priority));
  const topPriorityPlatforms = availablePlatforms.filter(
    (p) => p.priority === maxPriority
  );

  const selectedPlatform = selectPlatformByWeight(topPriorityPlatforms);
  if (!selectedPlatform) return null;

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
  const platform = platformCache.find(
    (p) => p.id === platformId && isPlatformAvailable(p)
  );
  return platform ?? null;
}

/**
 * 获取所有可用平台列表
 */
export async function getAvailablePlatforms(): Promise<PlatformConfig[]> {
  await refreshCache();
  return platformCache.filter(isPlatformAvailable);
}
