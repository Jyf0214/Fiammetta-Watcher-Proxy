import { prisma } from "./prisma";
import type { PlatformConfig, RouteDecision, ModelMapConfig } from "@/types";

// 内存缓存，避免每次请求都查数据库
let platformCache: PlatformConfig[] = [];
let modelMapCache: ModelMapConfig[] = [];
let lastRefresh = 0;
const CACHE_TTL = 30_000; // 30 秒缓存

/**
 * 刷新平台和模型映射缓存
 */
async function refreshCache() {
  const now = Date.now();
  if (now - lastRefresh < CACHE_TTL && platformCache.length > 0) return;

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
  lastRefresh = now;
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
 */
function isPlatformAvailable(platform: PlatformConfig): boolean {
  if (!platform.enabled) return false;
  if (platform.status === "down") return false;
  if (platform.cooldownEnd && platform.cooldownEnd > new Date()) return false;
  return true;
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
