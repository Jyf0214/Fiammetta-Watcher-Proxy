/**
 * 内存速率限制器（Pages API 专用）
 *
 * 替代 CF KV 实现，使用内存 Map 存储计数器。
 * 冷启动后计数器重置（可接受，限流是尽力而为的）。
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

export async function checkPlatformRpm(platformId: string, rpmLimit: number | null, _kv?: KVNamespace): Promise<RateLimitResult> {
  if (rpmLimit === null) return { allowed: true, remaining: Infinity, resetAt: Date.now() + WINDOW_MS };
  cleanup();
  const now = Date.now(), ws = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const c = await getCount(rpmCounters, RATE_PREFIX, platformId, ws);
  if (c >= rpmLimit - 1) return { allowed: false, remaining: 0, resetAt: ws + WINDOW_MS };
  await incCount(rpmCounters, RATE_PREFIX, platformId, ws);
  return { allowed: true, remaining: Math.max(0, rpmLimit - c - 1), resetAt: ws + WINDOW_MS };
}

export async function checkPlatformTpm(platformId: string, tpmLimit: number | null, est: number, _kv?: KVNamespace): Promise<RateLimitResult> {
  if (tpmLimit === null) return { allowed: true, remaining: Infinity, resetAt: Date.now() + WINDOW_MS };
  cleanup();
  const now = Date.now(), ws = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const c = await getCount(tpmCounters, TPM_PREFIX, platformId, ws);
  if (c + est > tpmLimit) return { allowed: false, remaining: 0, resetAt: ws + WINDOW_MS };
  await incCount(tpmCounters, TPM_PREFIX, platformId, ws, est);
  return { allowed: true, remaining: Math.max(0, tpmLimit - c - est), resetAt: ws + WINDOW_MS };
}

export async function checkApiKeyRpm(apiKeyId: string, rpmLimit: number | null, _kv?: KVNamespace): Promise<RateLimitResult> {
  if (rpmLimit === null) return { allowed: true, remaining: Infinity, resetAt: Date.now() + WINDOW_MS };
  cleanup();
  const now = Date.now(), ws = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const c = await getCount(rpmCounters, RATE_PREFIX, `key:${apiKeyId}`, ws);
  if (c >= rpmLimit - 1) return { allowed: false, remaining: 0, resetAt: ws + WINDOW_MS };
  await incCount(rpmCounters, RATE_PREFIX, `key:${apiKeyId}`, ws);
  return { allowed: true, remaining: Math.max(0, rpmLimit - c - 1), resetAt: ws + WINDOW_MS };
}

export async function checkApiKeyTpm(apiKeyId: string, tpmLimit: number | null, est: number, _kv?: KVNamespace): Promise<RateLimitResult> {
  if (tpmLimit === null) return { allowed: true, remaining: Infinity, resetAt: Date.now() + WINDOW_MS };
  cleanup();
  const now = Date.now(), ws = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const c = await getCount(tpmCounters, TPM_PREFIX, `key:${apiKeyId}`, ws);
  if (c + est > tpmLimit) return { allowed: false, remaining: 0, resetAt: ws + WINDOW_MS };
  await incCount(tpmCounters, TPM_PREFIX, `key:${apiKeyId}`, ws, est);
  return { allowed: true, remaining: Math.max(0, tpmLimit - c - est), resetAt: ws + WINDOW_MS };
}
