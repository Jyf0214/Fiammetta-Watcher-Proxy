import type { RateLimitResult } from "@/types";

// 内存存储的固定窗口计数器
// 生产环境建议使用 Redis
interface WindowEntry {
  count: number;
  tokens: number;
  windowStart: number;
}

const platformWindows = new Map<string, WindowEntry>();
const apiKeyWindows = new Map<string, WindowEntry>();
const CLEANUP_INTERVAL = 60_000; // 每分钟清理过期窗口
const MAX_WINDOWS_SIZE = 200; // 最大窗口数量，防止内存溢出

/**
 * 检查平台速率限制（RPM + TPM）
 */
export function checkPlatformRateLimit(
  platformId: string,
  rpmLimit: number | null,
  tpmLimit: number | null,
  tokenCount: number = 0
): RateLimitResult {
  if (tokenCount < 0) tokenCount = 0;
  const now = Date.now();
  const windowMs = 60_000; // 1 分钟窗口

  let entry = platformWindows.get(platformId);

  // 窗口过期，重置
  if (!entry || now - entry.windowStart >= windowMs) {
    entry = { count: 0, tokens: 0, windowStart: now };
    platformWindows.set(platformId, entry);
  }

  // 检查 RPM 限制
  if (rpmLimit !== null && entry.count >= rpmLimit) {
    const resetAt = entry.windowStart + windowMs;
    return { allowed: false, remaining: 0, resetAt };
  }

  // 检查 TPM 限制（与 RPM 保持一致使用 >=）
  if (tpmLimit !== null && entry.tokens + tokenCount >= tpmLimit) {
    const resetAt = entry.windowStart + windowMs;
    return { allowed: false, remaining: 0, resetAt };
  }

  // 允许请求，更新计数
  entry.count += 1;
  entry.tokens += tokenCount;

  const remaining = rpmLimit !== null ? rpmLimit - entry.count : Infinity;
  const resetAt = entry.windowStart + windowMs;

  return { allowed: true, remaining, resetAt };
}

/**
 * 记录平台实际 token 用量（追溯性 TPM 追踪）
 * 在请求完成后调用，仅更新 token 计数器，不重复计算 RPM。
 * 返回 TPM 是否已超限（请求已完成，仅记录警告，不拒绝）。
 */
export function recordPlatformTokens(
  platformId: string,
  tpmLimit: number | null,
  tokenCount: number
): RateLimitResult {
  if (tokenCount <= 0 || tpmLimit === null) {
    return {
      allowed: true,
      remaining: Infinity,
      resetAt: Date.now() + 60_000,
    };
  }

  const now = Date.now();
  const windowMs = 60_000;

  let entry = platformWindows.get(platformId);

  // 窗口过期，重置
  if (!entry || now - entry.windowStart >= windowMs) {
    entry = { count: 0, tokens: 0, windowStart: now };
    platformWindows.set(platformId, entry);
  }

  // 先更新 token 记录，再检查是否超限
  entry.tokens += tokenCount;

  if (entry.tokens >= tpmLimit) {
    return { allowed: false, remaining: 0, resetAt: entry.windowStart + windowMs };
  }

  return {
    allowed: true,
    remaining: tpmLimit - entry.tokens,
    resetAt: entry.windowStart + windowMs,
  };
}

/**
 * 检查 API Key 级别速率限制（RPM + TPM）
 */
export function checkApiKeyRateLimit(
  apiKeyId: string,
  rpmLimit: number | null,
  tpmLimit: number | null,
  tokenCount: number = 0
): RateLimitResult {
  if (tokenCount < 0) tokenCount = 0;
  const now = Date.now();
  const windowMs = 60_000; // 1 分钟窗口

  let entry = apiKeyWindows.get(apiKeyId);

  // 窗口过期，重置
  if (!entry || now - entry.windowStart >= windowMs) {
    entry = { count: 0, tokens: 0, windowStart: now };
    apiKeyWindows.set(apiKeyId, entry);
  }

  // 检查 RPM 限制
  if (rpmLimit !== null && entry.count >= rpmLimit) {
    const resetAt = entry.windowStart + windowMs;
    return { allowed: false, remaining: 0, resetAt };
  }

  // 检查 TPM 限制
  if (tpmLimit !== null && entry.tokens + tokenCount >= tpmLimit) {
    const resetAt = entry.windowStart + windowMs;
    return { allowed: false, remaining: 0, resetAt };
  }

  // 允许请求，更新计数
  entry.count += 1;
  entry.tokens += tokenCount;

  const remaining = rpmLimit !== null ? rpmLimit - entry.count : Infinity;
  const resetAt = entry.windowStart + windowMs;

  return { allowed: true, remaining, resetAt };
}

/**
 * 检查 Key 级别速率限制（RPM + TPM）— checkApiKeyRateLimit 的别名
 * 用于 route 文件中更简洁的调用
 */
export function checkKeyRateLimit(
  keyId: string,
  rpmLimit: number | null,
  tpmLimit: number | null,
  tokenCount: number = 0
): RateLimitResult {
  return checkApiKeyRateLimit(keyId, rpmLimit, tpmLimit, tokenCount);
}

/**
 * 记录 API Key 实际 token 用量（追溯性 TPM 追踪）
 * 在请求完成后调用，仅更新 token 计数器，不重复计算 RPM。
 */
export function recordApiKeyTokens(
  apiKeyId: string,
  tpmLimit: number | null,
  tokenCount: number
): RateLimitResult {
  if (tokenCount <= 0 || tpmLimit === null) {
    return {
      allowed: true,
      remaining: Infinity,
      resetAt: Date.now() + 60_000,
    };
  }

  const now = Date.now();
  const windowMs = 60_000;

  let entry = apiKeyWindows.get(apiKeyId);

  // 窗口过期，重置
  if (!entry || now - entry.windowStart >= windowMs) {
    entry = { count: 0, tokens: 0, windowStart: now };
    apiKeyWindows.set(apiKeyId, entry);
  }

  // 先更新 token 记录，再检查是否超限
  entry.tokens += tokenCount;

  if (entry.tokens >= tpmLimit) {
    return { allowed: false, remaining: 0, resetAt: entry.windowStart + windowMs };
  }

  return {
    allowed: true,
    remaining: tpmLimit - entry.tokens,
    resetAt: entry.windowStart + windowMs,
  };
}

/**
 * 获取平台当前速率限制状态
 */
export function getPlatformRateStatus(platformId: string) {
  const entry = platformWindows.get(platformId);
  if (!entry) return { rpm: 0, tpm: 0, windowStart: 0 };

  return {
    rpm: entry.count,
    tpm: entry.tokens,
    windowStart: entry.windowStart,
  };
}

// 清理定时器 ID，用于导出 stopRateLimitCleanup 时清除
let cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

/**
 * 启动定期清理过期窗口的定时器
 */
export function startRateLimitCleanup() {
  cleanupIntervalId = setInterval(() => {
    const now = Date.now();
    // 清理平台级过期窗口
    for (const [platformId, entry] of platformWindows.entries()) {
      if (now - entry.windowStart >= 120_000) {
        // 2 分钟未活动
        platformWindows.delete(platformId);
      }
    }
    // 清理 API Key 级过期窗口
    for (const [apiKeyId, entry] of apiKeyWindows.entries()) {
      if (now - entry.windowStart >= 120_000) {
        // 2 分钟未活动
        apiKeyWindows.delete(apiKeyId);
      }
    }
    // 防止内存溢出：超出上限时按时间戳排序淘汰最旧的
    if (platformWindows.size > MAX_WINDOWS_SIZE) {
      const sorted = [...platformWindows.entries()].sort((a, b) => a[1].windowStart - b[1].windowStart);
      const excess = sorted.slice(0, platformWindows.size - MAX_WINDOWS_SIZE);
      for (const [key] of excess) platformWindows.delete(key);
    }
    if (apiKeyWindows.size > MAX_WINDOWS_SIZE) {
      const sorted = [...apiKeyWindows.entries()].sort((a, b) => a[1].windowStart - b[1].windowStart);
      const excess = sorted.slice(0, apiKeyWindows.size - MAX_WINDOWS_SIZE);
      for (const [key] of excess) apiKeyWindows.delete(key);
    }
  }, CLEANUP_INTERVAL);
}

/**
 * 停止清理定时器（用于进程优雅退出时调用）
 */
export function stopRateLimitCleanup() {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }
}
