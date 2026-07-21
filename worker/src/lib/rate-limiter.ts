/**
 * 速率限制器 — 固定窗口计数器
 *
 * 使用 KV 存储窗口计数器（替代内存 Map），支持 Cloudflare Workers 分布式运行。
 * KV key 前缀：
 * - "rl:platform:" — 平台级速率限制
 * - "rl:key:" — API Key 级速率限制
 * KV TTL 120 秒（自动过期清理，替代手动清理定时器）
 *
 * 固定窗口算法：1 分钟窗口，每次请求更新计数器。
 * 优点：实现简单、KV TTL 自动清理。
 * 缺点：窗口边界可能出现突发流量（可通过缩短窗口缓解）。
 *
 * 已知限制 — KV 读写竞态（最终一致性）：
 * getWindow → 修改 → saveWindow 不是原子操作。在高并发下，
 * 两个请求可能同时读到相同计数器值并各自写回，导致计数偏低。
 * Cloudflare KV 本身是最终一致存储，无法提供 compare-and-swap。
 * 因此速率限制仅作为"尽力而为"的软限制，不保证精确。
 * 如果需要精确限制，应使用 Cloudflare Rate Limiting（边缘层）或 Durable Objects。
 */

import type { KVNamespace } from "@cloudflare/workers-types";

/** 速率限制检查结果 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/** KV 中存储的窗口数据 */
interface WindowData {
  count: number;
  tokens: number;
  windowStart: number;
}

/** KV TTL：120 秒（自动过期清理） */
const KV_TTL_SECONDS = 120;
/** 固定窗口时长：1 分钟 */
const WINDOW_MS = 60_000;

/**
 * 构造 KV key
 */
function platformKey(platformId: string): string {
  return `rl:platform:${platformId}`;
}

function apiKey(keyId: string): string {
  return `rl:key:${keyId}`;
}

/**
 * 从 KV 读取窗口数据，若不存在或已过期则返回空窗口
 */
async function getWindow(kv: KVNamespace, key: string): Promise<WindowData> {
  const raw = await kv.get(key);
  if (!raw) {
    return { count: 0, tokens: 0, windowStart: Date.now() };
  }
  try {
    const data: WindowData = JSON.parse(raw);
    // 窗口已过期，返回空窗口
    if (Date.now() - data.windowStart >= WINDOW_MS) {
      return { count: 0, tokens: 0, windowStart: Date.now() };
    }
    return data;
  } catch {
    return { count: 0, tokens: 0, windowStart: Date.now() };
  }
}

/**
 * 将窗口数据写入 KV（TTL 120 秒）
 */
async function saveWindow(kv: KVNamespace, key: string, data: WindowData): Promise<void> {
  await kv.put(key, JSON.stringify(data), { expirationTtl: KV_TTL_SECONDS });
}

/**
 * 检查平台速率限制（RPM + TPM）
 *
 * @param env Cloudflare 环境绑定
 * @param platformId 平台 ID
 * @param rpmLimit 每分钟请求限制（null 表示不限制）
 * @param tpmLimit 每分钟 token 限制（null 表示不限制）
 * @param tokenCount 本次请求预估 token 数
 */
export async function checkPlatformRateLimit(
  env: { KV: KVNamespace },
  platformId: string,
  rpmLimit: number | null,
  tpmLimit: number | null,
  tokenCount: number = 0
): Promise<RateLimitResult> {
  if (tokenCount < 0) tokenCount = 0;
  const key = platformKey(platformId);
  const entry = await getWindow(env.KV, key);

  // 检查 RPM 限制
  if (rpmLimit !== null && entry.count >= rpmLimit) {
    const resetAt = entry.windowStart + WINDOW_MS;
    return { allowed: false, remaining: 0, resetAt };
  }

  // 检查 TPM 限制（与 RPM 保持一致使用 >=）
  if (tpmLimit !== null && entry.tokens + tokenCount >= tpmLimit) {
    const resetAt = entry.windowStart + WINDOW_MS;
    return { allowed: false, remaining: 0, resetAt };
  }

  // 允许请求，更新计数
  entry.count += 1;
  entry.tokens += tokenCount;
  await saveWindow(env.KV, key, entry);

  const remaining = rpmLimit !== null ? rpmLimit - entry.count : Infinity;
  const resetAt = entry.windowStart + WINDOW_MS;

  return { allowed: true, remaining, resetAt };
}

/**
 * 记录平台实际 token 用量（追溯性 TPM 追踪）
 *
 * 在请求完成后调用，仅更新 token 计数器，不重复计算 RPM。
 * 返回 TPM 是否已超限（请求已完成，仅记录警告，不拒绝）。
 */
export async function recordPlatformTokens(
  env: { KV: KVNamespace },
  platformId: string,
  tpmLimit: number | null,
  tokenCount: number
): Promise<RateLimitResult> {
  if (tokenCount <= 0 || tpmLimit === null) {
    return {
      allowed: true,
      remaining: Infinity,
      resetAt: Date.now() + 60_000,
    };
  }

  const key = platformKey(platformId);
  const entry = await getWindow(env.KV, key);

  // 先更新 token 记录，再检查是否超限
  entry.tokens += tokenCount;
  await saveWindow(env.KV, key, entry);

  if (entry.tokens >= tpmLimit) {
    return { allowed: false, remaining: 0, resetAt: entry.windowStart + WINDOW_MS };
  }

  return {
    allowed: true,
    remaining: tpmLimit - entry.tokens,
    resetAt: entry.windowStart + WINDOW_MS,
  };
}

/**
 * 检查 API Key 级别速率限制（RPM + TPM）
 */
export async function checkApiKeyRateLimit(
  env: { KV: KVNamespace },
  keyId: string,
  rpmLimit: number | null,
  tpmLimit: number | null,
  tokenCount: number = 0
): Promise<RateLimitResult> {
  if (tokenCount < 0) tokenCount = 0;
  const key = apiKey(keyId);
  const entry = await getWindow(env.KV, key);

  // 检查 RPM 限制
  if (rpmLimit !== null && entry.count >= rpmLimit) {
    const resetAt = entry.windowStart + WINDOW_MS;
    return { allowed: false, remaining: 0, resetAt };
  }

  // 检查 TPM 限制
  if (tpmLimit !== null && entry.tokens + tokenCount >= tpmLimit) {
    const resetAt = entry.windowStart + WINDOW_MS;
    return { allowed: false, remaining: 0, resetAt };
  }

  // 允许请求，更新计数
  entry.count += 1;
  entry.tokens += tokenCount;
  await saveWindow(env.KV, key, entry);

  const remaining = rpmLimit !== null ? rpmLimit - entry.count : Infinity;
  const resetAt = entry.windowStart + WINDOW_MS;

  return { allowed: true, remaining, resetAt };
}

/**
 * 检查 Key 级别速率限制（RPM + TPM）— checkApiKeyRateLimit 的别名
 * 用于路由文件中更简洁的调用
 */
export async function checkKeyRateLimit(
  env: { KV: KVNamespace },
  keyId: string,
  rpmLimit: number | null,
  tpmLimit: number | null,
  tokenCount: number = 0
): Promise<RateLimitResult> {
  return checkApiKeyRateLimit(env, keyId, rpmLimit, tpmLimit, tokenCount);
}

/**
 * 记录 API Key 实际 token 用量（追溯性 TPM 追踪）
 *
 * 在请求完成后调用，仅更新 token 计数器，不重复计算 RPM。
 */
export async function recordApiKeyTokens(
  env: { KV: KVNamespace },
  apiKeyId: string,
  tpmLimit: number | null,
  tokenCount: number
): Promise<RateLimitResult> {
  if (tokenCount <= 0 || tpmLimit === null) {
    return {
      allowed: true,
      remaining: Infinity,
      resetAt: Date.now() + 60_000,
    };
  }

  const key = apiKey(apiKeyId);
  const entry = await getWindow(env.KV, key);

  // 先更新 token 记录，再检查是否超限
  entry.tokens += tokenCount;
  await saveWindow(env.KV, key, entry);

  if (entry.tokens >= tpmLimit) {
    return { allowed: false, remaining: 0, resetAt: entry.windowStart + WINDOW_MS };
  }

  return {
    allowed: true,
    remaining: tpmLimit - entry.tokens,
    resetAt: entry.windowStart + WINDOW_MS,
  };
}

// ==================== Admin API 速率限制 ====================

/** Admin API 速率限制：60 次/分钟/IP */
const ADMIN_RPM_LIMIT = 60;

function adminIpKey(ip: string): string {
  return `rl:admin:${ip}`;
}

/**
 * 检查 Admin API IP 级速率限制（60 次/分钟/IP）
 *
 * 用于 /api/admin/* 和 /api/setup/* 路由，防止暴力破解和滥用。
 */
export async function checkAdminRateLimit(
  env: { KV: KVNamespace },
  clientIp: string
): Promise<boolean> {
  const key = adminIpKey(clientIp);
  const entry = await getWindow(env.KV, key);

  if (entry.count >= ADMIN_RPM_LIMIT) {
    return false;
  }

  entry.count += 1;
  await saveWindow(env.KV, key, entry);
  return true;
}
