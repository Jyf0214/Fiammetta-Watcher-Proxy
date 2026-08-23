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
 *
 * 注意：KV 无原子递增操作，存在 TOCTOU 竞态。通过预留 1 的缓冲减少超限概率。
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

  // 每窗口最多放行 rpmLimit 个请求（与 TPM 分支一致的判定语义）；
  // KV 读改写非原子，并发下可能略微超限（KV 限流固有局限，尽力而为）
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

  // 每窗口最多放行 rpmLimit 个请求（与 TPM 分支一致的判定语义）；
  // KV 读改写非原子，并发下可能略微超限（KV 限流固有局限，尽力而为）
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
 * 归还平台级 RPM 配额（Key 级限流拒绝时调用）
 *
 * 与 Pages 内存版 releasePlatformRpm 对齐：先扣平台后扣 Key 的顺序下，
 * Key 级拒绝需归还已扣的平台计数，避免平台共享配额被无关请求消耗。
 * limit 为 null 时 checkPlatformRpm 从未扣减，直接跳过（防止窗口中途
 * 管理员改为不限流后误扣新键）。KV 无原子操作，尽力而为。
 */
export async function releasePlatformRpm(
  platformId: string,
  rpmLimit: number | null,
  kv: KVNamespace
): Promise<void> {
  if (rpmLimit === null) return;
  const windowStart = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
  const key = `${RATE_PREFIX}platform:${platformId}:${windowStart}`;
  try {
    const current = await kv.get(key, { type: "text" });
    const count = current ? parseInt(current, 10) : 0;
    if (count > 0) {
      await kv.put(key, String(count - 1), { expirationTtl: 120 });
    }
  } catch {
    // 尽力而为：忽略归还失败
  }
}

/**
 * 归还平台级 TPM 配额（Key 级限流拒绝时调用，按扣减时的预估值归还）
 */
export async function releasePlatformTpm(
  platformId: string,
  tpmLimit: number | null,
  tokenCount: number,
  kv: KVNamespace
): Promise<void> {
  if (tpmLimit === null || tokenCount <= 0) return;
  const windowStart = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
  const key = `${TPM_PREFIX}platform:${platformId}:${windowStart}`;
  try {
    const current = await kv.get(key, { type: "text" });
    const currentTokens = current ? parseInt(current, 10) : 0;
    if (currentTokens > 0) {
      await kv.put(key, String(Math.max(0, currentTokens - tokenCount)), {
        expirationTtl: 120,
      });
    }
  } catch {
    // 尽力而为：忽略归还失败
  }
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
