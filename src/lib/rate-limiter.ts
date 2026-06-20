import type { RateLimitResult } from "@/types";

// 内存存储的滑动窗口计数器
// 生产环境建议使用 Redis
interface WindowEntry {
  count: number;
  tokens: number;
  windowStart: number;
}

const platformWindows = new Map<string, WindowEntry>();
const CLEANUP_INTERVAL = 60_000; // 每分钟清理过期窗口

/**
 * 检查平台速率限制（RPM + TPM）
 */
export function checkPlatformRateLimit(
  platformId: string,
  rpmLimit: number | null,
  tpmLimit: number | null,
  tokenCount: number = 0
): RateLimitResult {
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

/**
 * 定期清理过期窗口
 */
export function startRateLimitCleanup() {
  setInterval(() => {
    const now = Date.now();
    for (const [platformId, entry] of platformWindows.entries()) {
      if (now - entry.windowStart >= 120_000) {
        // 2 分钟未活动
        platformWindows.delete(platformId);
      }
    }
  }, CLEANUP_INTERVAL);
}

// 模块自初始化：首次导入时自动启动清理定时器，防止 Map 无限增长
startRateLimitCleanup();
