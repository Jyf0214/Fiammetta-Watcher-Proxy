/**
 * 代理路由 — 为每个请求选择最佳代理
 *
 * 策略：
 * - 只选择状态为 healthy 或 degraded（未封禁）的代理
 * - Round-robin 轮询，均匀分摊各代理负载
 * - 代理列表按平台缓存，30 秒刷新
 */

import { prisma } from "./prisma";
import { isDebug } from "./auth-helpers";
import type { Proxy } from "@prisma/client";

/** 代理缓存 */
let proxyCache: Map<string, Proxy[]> = new Map();
let lastRefresh = 0;
const CACHE_TTL = 30_000;

/** 每个平台独立的轮询计数器 */
const counters = new Map<string, number>();

/**
 * 刷新代理缓存
 */
async function refreshProxyCache() {
  const now = Date.now();
  if (now - lastRefresh < CACHE_TTL) return;

  const proxies = await prisma.proxy.findMany({
    where: { enabled: true },
    orderBy: { createdAt: "asc" },
  });

  const grouped = new Map<string, Proxy[]>();
  for (const p of proxies) {
    const list = grouped.get(p.platformId) ?? [];
    list.push(p);
    grouped.set(p.platformId, list);
  }

  proxyCache = grouped;
  lastRefresh = now;
}

/**
 * 判断代理是否可用（未处于封禁冷却期）
 */
function isProxyAvailable(proxy: Proxy): boolean {
  if (!proxy.enabled) return false;
  if (proxy.status === "down" && proxy.cooldownEnd && proxy.cooldownEnd > new Date()) {
    return false;
  }
  return true;
}

/**
 * 为指定平台选择下一个可用代理
 *
 * @param platformId 平台 ID
 * @returns 可用的代理记录，无可用代理返回 null
 */
export async function selectProxy(platformId: string): Promise<Proxy | null> {
  await refreshProxyCache();

  const proxies = proxyCache.get(platformId) ?? [];
  const available = proxies.filter(isProxyAvailable);

  if (isDebug) {
    console.log(
      `[proxy-debug] selectProxy platform=${platformId} total=${proxies.length} available=${available.length} disabled=${proxies.filter(p => !p.enabled).length} down=${proxies.filter(p => p.status === "down").length}`
    );
  }

  if (available.length === 0) return null;

  const counter = counters.get(platformId) ?? 0;
  const index = counter % available.length;
  counters.set(platformId, counter + 1);

  const selected = available[index];
  if (isDebug) {
    console.log(`[proxy-debug] selectProxy 选中: id=${selected.id} address=${selected.address} status=${selected.status} failCount=${selected.failCount}`);
  }

  return selected;
}

/**
 * 强制刷新代理缓存（在代理变更后调用）
 */
export async function forceRefreshProxyCache() {
  lastRefresh = 0;
  await refreshProxyCache();
}

/**
 * 获取平台的代理统计信息
 */
export async function getProxyStats(platformId: string) {
  await refreshProxyCache();

  const proxies = proxyCache.get(platformId) ?? [];
  const now = new Date();
  let healthy = 0;
  let degraded = 0;
  let down = 0;

  for (const p of proxies) {
    if (!p.enabled) continue;
    if (p.status === "down" && p.cooldownEnd && p.cooldownEnd > now) {
      down++;
    } else if (p.status === "healthy") {
      healthy++;
    } else {
      degraded++;
    }
  }

  return { total: proxies.length, healthy, degraded, down };
}
