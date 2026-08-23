/**
 * 内存速率限制器（Pages /v1 入口专用）
 *
 * 本实现为纯进程内内存计数：计数器只存在于当前进程的 Map 中，不使用任何外部存储
 * （无 KV 等参数，函数签名不接收存储句柄——调用方勿误以为可传入 KV 获得全局计数）。
 * 供 pages/api/v1/[[...v1]].ts 在非 Cloudflare 部署（Docker/EdgeOne 等）下使用。
 *
 * 部署语义：
 * - Pages 单实例部署：限额按配置准确生效；
 * - Pages 多副本部署：各副本独立计数互不共享，实际放行量约等于 限额 × 副本数
 *   （线性放大），单副本内的限额仍然有效；
 * - 冷启动后计数器重置（可接受，限流是尽力而为的）。
 *
 * Cloudflare Worker 部署使用 worker/src/rate-limiter.ts（KV 全局计数），与本文件
 * 是两份独立实现：导出同名、调用方不同，计数器互不共享。
 */

import type { RateLimitResult } from "@/lib/types";

const WINDOW_MS = 60_000;
const RATE_PREFIX = "rate:";
const TPM_PREFIX = "tpm:";

interface CounterEntry { count: number; windowStart: number; }
const rpmCounters = new Map<string, CounterEntry>();
const tpmCounters = new Map<string, CounterEntry>();
let lastCleanup = Date.now();
const CLEANUP_INTERVAL = 5 * 60 * 1000;

function cleanup(): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanup = now;
  const ws = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  for (const [k, e] of rpmCounters) { if (e.windowStart < ws) rpmCounters.delete(k); }
  for (const [k, e] of tpmCounters) { if (e.windowStart < ws) tpmCounters.delete(k); }
}

async function getCount(store: Map<string, CounterEntry>, prefix: string, id: string, ws: number): Promise<number> {
  const e = store.get(`${prefix}${id}:${ws}`);
  return e && e.windowStart === ws ? e.count : 0;
}

async function incCount(store: Map<string, CounterEntry>, prefix: string, id: string, ws: number, inc = 1): Promise<void> {
  const k = `${prefix}${id}:${ws}`;
  const e = store.get(k);
  if (e && e.windowStart === ws) e.count += inc;
  else store.set(k, { count: inc, windowStart: ws });
}

/** 与 incCount 对称的递减：条目不存在或计数不足时不产生负数（防御性，直接忽略） */
async function decCount(store: Map<string, CounterEntry>, prefix: string, id: string, ws: number, dec = 1): Promise<void> {
  const k = `${prefix}${id}:${ws}`;
  const e = store.get(k);
  if (!e || e.windowStart !== ws) return;
  if (e.count <= dec) store.delete(k);
  else e.count -= dec;
}

/**
 * 回滚一次平台级 RPM 扣减（Key 级 RPM 拒绝时调用）
 *
 * 调用顺序为「先扣平台、后扣 Key」，Key 级拒绝时平台侧已扣的计数若不归还，
 * 会被与该客户端无关的后续请求白白消耗。rpmLimit 与扣减时一致传入：
 * 为 null 时 checkPlatformRpm 从未扣减，此处也必须跳过（否则误减他人计数）；
 * 窗口翻转后回滚落在旧窗口键上，随 cleanup 过期，无副作用。
 */
export async function releasePlatformRpm(platformId: string, rpmLimit: number | null): Promise<void> {
  if (rpmLimit === null) return;
  const ws = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
  await decCount(rpmCounters, RATE_PREFIX, platformId, ws);
}

/**
 * 回滚一次平台级 TPM 扣减（Key 级 TPM 拒绝时调用）
 *
 * est 必须与 checkPlatformTpm 扣减时的预估 token 数一致，否则归还量错位。
 * tpmLimit 为 null 或 est <= 0 时 checkPlatformTpm 从未扣减，跳过。
 */
export async function releasePlatformTpm(platformId: string, tpmLimit: number | null, est: number): Promise<void> {
  if (tpmLimit === null || est <= 0) return;
  const ws = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
  await decCount(tpmCounters, TPM_PREFIX, platformId, ws, est);
}

export async function checkPlatformRpm(platformId: string, rpmLimit: number | null): Promise<RateLimitResult> {
  if (rpmLimit === null) return { allowed: true, remaining: Infinity, resetAt: Date.now() + WINDOW_MS };
  cleanup();
  const now = Date.now(), ws = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const c = await getCount(rpmCounters, RATE_PREFIX, platformId, ws);
  if (c >= rpmLimit) return { allowed: false, remaining: 0, resetAt: ws + WINDOW_MS };
  await incCount(rpmCounters, RATE_PREFIX, platformId, ws);
  return { allowed: true, remaining: Math.max(0, rpmLimit - c - 1), resetAt: ws + WINDOW_MS };
}

export async function checkPlatformTpm(platformId: string, tpmLimit: number | null, est: number): Promise<RateLimitResult> {
  if (tpmLimit === null) return { allowed: true, remaining: Infinity, resetAt: Date.now() + WINDOW_MS };
  cleanup();
  const now = Date.now(), ws = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const c = await getCount(tpmCounters, TPM_PREFIX, platformId, ws);
  if (c + est >= tpmLimit) return { allowed: false, remaining: 0, resetAt: ws + WINDOW_MS };
  await incCount(tpmCounters, TPM_PREFIX, platformId, ws, est);
  return { allowed: true, remaining: Math.max(0, tpmLimit - c - est), resetAt: ws + WINDOW_MS };
}

export async function checkApiKeyRpm(apiKeyId: string, rpmLimit: number | null): Promise<RateLimitResult> {
  if (rpmLimit === null) return { allowed: true, remaining: Infinity, resetAt: Date.now() + WINDOW_MS };
  cleanup();
  const now = Date.now(), ws = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const c = await getCount(rpmCounters, RATE_PREFIX, `key:${apiKeyId}`, ws);
  if (c >= rpmLimit) return { allowed: false, remaining: 0, resetAt: ws + WINDOW_MS };
  await incCount(rpmCounters, RATE_PREFIX, `key:${apiKeyId}`, ws);
  return { allowed: true, remaining: Math.max(0, rpmLimit - c - 1), resetAt: ws + WINDOW_MS };
}

export async function checkApiKeyTpm(apiKeyId: string, tpmLimit: number | null, est: number): Promise<RateLimitResult> {
  if (tpmLimit === null) return { allowed: true, remaining: Infinity, resetAt: Date.now() + WINDOW_MS };
  cleanup();
  const now = Date.now(), ws = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const c = await getCount(tpmCounters, TPM_PREFIX, `key:${apiKeyId}`, ws);
  if (c + est >= tpmLimit) return { allowed: false, remaining: 0, resetAt: ws + WINDOW_MS };
  await incCount(tpmCounters, TPM_PREFIX, `key:${apiKeyId}`, ws, est);
  return { allowed: true, remaining: Math.max(0, tpmLimit - c - est), resetAt: ws + WINDOW_MS };
}
