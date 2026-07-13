/**
 * 代理路由 — 为每个请求选择最佳代理
 *
 * 全局代理池，所有平台共享，按请求轮转。
 *
 * 策略：
 * - 只选择状态为 healthy 或 degraded（未封禁）的代理
 * - 并发感知轮转：同一平台的不同 key 优先分配不同的代理
 * - 若所有代理均被同一平台占用，回退到 round-robin 复用
 * - 代理列表全局缓存，30 秒刷新
 * - 缓存大小限制，防止内存溢出
 */

import { prisma } from "./prisma";
import { isDebug } from "./auth-helpers";
import type { Proxy } from "@prisma/client";

/** 全局代理缓存 */
let proxyCache: Proxy[] = [];
let lastRefresh = 0;
const CACHE_TTL = 30_000;
const MAX_PROXY_CACHE_SIZE = 500; // 代理缓存上限，防止内存溢出

/** 全局 round-robin 计数器（回退用） */
let globalCounter = 0;

/**
 * 平台级并发占用追踪
 *
 * 结构：Map<platformId, Map<proxyId, Set<keyId>>>
 * 含义：某平台的某个代理当前正在服务哪些 key
 *
 * 请求开始时调用 acquireProxy() 写入，请求结束时调用 releaseProxy() 清除。
 * 内存态，重启归零，多实例各自独立（尽力而为）。
 */
const activeAssignments = new Map<string, Map<string, Set<string>>>();

/**
 * 刷新代理缓存
 */
async function refreshProxyCache() {
  const now = Date.now();
  if (now - lastRefresh < CACHE_TTL) return;

  const proxies = await prisma.proxy.findMany({
    where: { enabled: true },
    orderBy: { createdAt: "asc" },
    take: MAX_PROXY_CACHE_SIZE, // 限制查询数量，防止内存溢出
  });

  proxyCache = proxies;
  lastRefresh = now;
}

/**
 * 判断代理是否可用
 *
 * 代理状态：
 * - healthy: 完全可用，优先选择
 * - degraded: 恢复中（自动测试通过后渐进恢复），可用但降低选中概率
 * - down + cooldownEnd > now（封禁）: 不可用
 * - down + cooldownEnd <= now（未使用）: 封禁已到期但未测试恢复，不可用
 */
function isProxyAvailable(proxy: Proxy): boolean {
  if (!proxy.enabled) return false;

  if (proxy.status === "down") {
    // 无论封禁是否到期，down 状态一律不可用
    // 封禁中：等待封禁到期
    // 未使用：封禁已到期，等待自动测试恢复
    return false;
  }

  if (proxy.status === "degraded") {
    // 恢复中：可用但降低选中概率
    return Math.random() > 0.5;
  }

  return true;
}

/**
 * 为指定平台选择下一个可用代理（并发感知）
 *
 * @param platformId 平台 ID（用于并发占用追踪）
 * @param keyId 当前请求的 API Key ID（用于占用追踪）
 * @returns 可用的代理记录，无可用代理返回 null
 */
export async function selectProxy(platformId: string, keyId?: string): Promise<Proxy | null> {
  await refreshProxyCache();

  const available = proxyCache.filter(isProxyAvailable);

  if (isDebug) {
    const total = proxyCache.length;
    const down = proxyCache.filter(p => p.status === "down").length;
    const disabled = proxyCache.filter(p => !p.enabled).length;
    console.log(
      `[proxy-debug] selectProxy platform=${platformId} total=${total} available=${available.length} disabled=${disabled} down=${down}`
    );
  }

  if (available.length === 0) return null;

  // 1. 查找当前平台未被任何 key 占用的代理（优先选择）
  const platformAssignments = activeAssignments.get(platformId);
  const occupiedProxyIds = new Set<string>();
  if (platformAssignments) {
    for (const [proxyId, keySet] of platformAssignments) {
      if (keySet.size > 0) {
        occupiedProxyIds.add(proxyId);
      }
    }
  }

  const unoccupied = available.filter(p => !occupiedProxyIds.has(p.id));

  let selected: Proxy;

  if (unoccupied.length > 0) {
    // 有未占用的代理，round-robin 从中选择
    const index = globalCounter % unoccupied.length;
    selected = unoccupied[index];
    globalCounter++;
  } else {
    // 所有代理均被占用，回退到全局 round-robin（复用）
    const index = globalCounter % available.length;
    selected = available[index];
    globalCounter++;
  }

  // 2. 记录占用
  if (keyId) {
    acquireProxy(platformId, selected.id, keyId);
  }

  if (isDebug) {
    const occupiedCount = occupiedProxyIds.size;
    console.log(
      `[proxy-debug] selectProxy 选中: id=${selected.id} address=${selected.address} status=${selected.status} failCount=${selected.failCount} occupied=${occupiedCount}/${available.length}`
    );
  }

  return selected;
}

/**
 * 标记代理被某个 key 占用
 */
function acquireProxy(platformId: string, proxyId: string, keyId: string): void {
  let platformMap = activeAssignments.get(platformId);
  if (!platformMap) {
    platformMap = new Map();
    activeAssignments.set(platformId, platformMap);
  }
  let keySet = platformMap.get(proxyId);
  if (!keySet) {
    keySet = new Set();
    platformMap.set(proxyId, keySet);
  }
  keySet.add(keyId);
}

/**
 * 释放代理占用（请求结束后调用）
 *
 * 包含内存清理逻辑：
 * - 清理空的 keySet
 * - 清理空的 platformMap
 * - 当 activeAssignments 过大时清理最旧的平台（防止内存泄漏）
 */
export function releaseProxy(platformId: string, proxyId: string, keyId: string): void {
  const platformMap = activeAssignments.get(platformId);
  if (!platformMap) return;
  const keySet = platformMap.get(proxyId);
  if (!keySet) return;
  keySet.delete(keyId);
  // 清理空条目
  if (keySet.size === 0) {
    platformMap.delete(proxyId);
  }
  if (platformMap.size === 0) {
    activeAssignments.delete(platformId);
  }

  // 防止内存泄漏：当平台数量过多时清理
  if (activeAssignments.size > 100) {
    const firstKey = activeAssignments.keys().next().value;
    if (firstKey) activeAssignments.delete(firstKey);
  }
}

/**
 * 强制刷新代理缓存（在代理变更后调用）
 */
export async function forceRefreshProxyCache() {
  lastRefresh = 0;
  await refreshProxyCache();
}

/**
 * 获取代理全局统计信息
 */
export async function getProxyStats() {
  await refreshProxyCache();

  const now = new Date();
  let healthy = 0;
  let degraded = 0;
  let banned = 0; // 封禁中（cooldownEnd > now）
  let unused = 0; // 未使用（cooldownEnd <= now，等待自动测试恢复）

  for (const p of proxyCache) {
    if (!p.enabled) continue;
    if (p.status === "down") {
      if (p.cooldownEnd && p.cooldownEnd > now) {
        banned++;
      } else {
        unused++;
      }
    } else if (p.status === "healthy") {
      healthy++;
    } else {
      degraded++;
    }
  }

  return { total: proxyCache.length, healthy, degraded, banned, unused };
}
