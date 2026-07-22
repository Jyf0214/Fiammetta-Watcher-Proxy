/**
 * 速率限制器 — 基于 Cloudflare KV
 *
 * 使用 KV 存储固定窗口计数器，实现：
 * - 平台级 RPM/TPM 限制
 * - API Key 级 RPM/TPM 限制
 * - 窗口自动过期（TTL 120 秒）
 *
 * KV 写入有最终一致性延迟，限制值可能略超配额（尽力而为）
 */

import type { RateLimitResult } from "@/lib/types";

/** KV 键前缀 */
const RATE_PREFIX = "rate:";
const TPM_PREFIX = "tpm:";

/** 固定窗口大小（毫秒） */
const WINDOW_MS = 60_000;

/**
 * 检查平台级 RPM 限制
 *
 * @param platformId - 平台 ID
 * @param rpmLimit - RPM 限制（null 表示不限制）
 * @param kv - KV 命名空间
 * @returns 限制结果
 */
export async function checkPlatformRpm(
  platformId: string,
  rpmLimit: number | null,
  kv: KVNamespace
): Promise<RateLimitResult> {
  if (rpmLimit === null) {
    return { allowed: true, remaining: Infinity, resetAt: Date.now() + WINDOW_MS };
  }

  const now = Date.now();
  const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const key = `${RATE_PREFIX}platform:${platformId}:${windowStart}`;

  const current = await kv.get(key, { type: "text" });
  const count = current ? parseInt(current, 10) : 0;

  if (count >= rpmLimit) {
    return { allowed: false, remaining: 0, resetAt: windowStart + WINDOW_MS };
  }

  // 原子递增
  await kv.put(key, String(count + 1), {
    expirationTtl: 120,
  });

  return {
    allowed: true,
    remaining: rpmLimit - count - 1,
    resetAt: windowStart + WINDOW_MS,
  };
}

/**
 * 检查平台级 TPM 限制
 */
export async function checkPlatformTpm(
  platformId: string,
  tpmLimit: number | null,
  tokenCount: number,
  kv: KVNamespace
): Promise<RateLimitResult> {
  if (tpmLimit === null || tokenCount <= 0) {
    return { allowed: true, remaining: Infinity, resetAt: Date.now() + WINDOW_MS };
  }

  const now = Date.now();
  const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const key = `${TPM_PREFIX}platform:${platformId}:${windowStart}`;

  const current = await kv.get(key, { type: "text" });
  const currentTokens = current ? parseInt(current, 10) : 0;

  if (currentTokens + tokenCount >= tpmLimit) {
    return { allowed: false, remaining: 0, resetAt: windowStart + WINDOW_MS };
  }

  await kv.put(key, String(currentTokens + tokenCount), {
    expirationTtl: 120,
  });

  return {
    allowed: true,
    remaining: tpmLimit - currentTokens - tokenCount,
    resetAt: windowStart + WINDOW_MS,
  };
}

/**
 * 记录平台实际 token 用量（追溯性 TPM 追踪）
 */
export async function recordPlatformTokens(
  platformId: string,
  tpmLimit: number | null,
  tokenCount: number,
  kv: KVNamespace
): Promise<void> {
  if (tokenCount <= 0 || tpmLimit === null) return;

  const now = Date.now();
  const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const key = `${TPM_PREFIX}platform:${platformId}:${windowStart}`;

  const current = await kv.get(key, { type: "text" });
  const currentTokens = current ? parseInt(current, 10) : 0;

  await kv.put(key, String(currentTokens + tokenCount), {
    expirationTtl: 120,
  });
}

/**
 * 检查 API Key 级 RPM 限制
 */
export async function checkApiKeyRpm(
  apiKeyId: string,
  rpmLimit: number | null,
  kv: KVNamespace
): Promise<RateLimitResult> {
  if (rpmLimit === null) {
    return { allowed: true, remaining: Infinity, resetAt: Date.now() + WINDOW_MS };
  }

  const now = Date.now();
  const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const key = `${RATE_PREFIX}key:${apiKeyId}:${windowStart}`;

  const current = await kv.get(key, { type: "text" });
  const count = current ? parseInt(current, 10) : 0;

  if (count >= rpmLimit) {
    return { allowed: false, remaining: 0, resetAt: windowStart + WINDOW_MS };
  }

  await kv.put(key, String(count + 1), {
    expirationTtl: 120,
  });

  return {
    allowed: true,
    remaining: rpmLimit - count - 1,
    resetAt: windowStart + WINDOW_MS,
  };
}

/**
 * 检查 API Key 级 TPM 限制
 */
export async function checkApiKeyTpm(
  apiKeyId: string,
  tpmLimit: number | null,
  tokenCount: number,
  kv: KVNamespace
): Promise<RateLimitResult> {
  if (tpmLimit === null || tokenCount <= 0) {
    return { allowed: true, remaining: Infinity, resetAt: Date.now() + WINDOW_MS };
  }

  const now = Date.now();
  const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const key = `${TPM_PREFIX}key:${apiKeyId}:${windowStart}`;

  const current = await kv.get(key, { type: "text" });
  const currentTokens = current ? parseInt(current, 10) : 0;

  if (currentTokens + tokenCount >= tpmLimit) {
    return { allowed: false, remaining: 0, resetAt: windowStart + WINDOW_MS };
  }

  await kv.put(key, String(currentTokens + tokenCount), {
    expirationTtl: 120,
  });

  return {
    allowed: true,
    remaining: tpmLimit - currentTokens - tokenCount,
    resetAt: windowStart + WINDOW_MS,
  };
}

/**
 * 记录 API Key 实际 token 用量
 */
export async function recordApiKeyTokens(
  apiKeyId: string,
  tpmLimit: number | null,
  tokenCount: number,
  kv: KVNamespace
): Promise<void> {
  if (tokenCount <= 0 || tpmLimit === null) return;

  const now = Date.now();
  const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const key = `${TPM_PREFIX}key:${apiKeyId}:${windowStart}`;

  const current = await kv.get(key, { type: "text" });
  const currentTokens = current ? parseInt(current, 10) : 0;

  await kv.put(key, String(currentTokens + tokenCount), {
    expirationTtl: 120,
  });
}
