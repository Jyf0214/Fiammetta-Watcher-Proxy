/**
 * 管理 API 全局速率限制（KV 滑动窗口）
 *
 * 用法：在 API handler 开头调用 await checkAdminRateLimit(adminId, res)
 * 如果被限流，函数会直接返回 false 并发送 429 响应
 *
 * 配置：100 次/分钟/管理员
 */

import type { NextApiResponse } from "next";

const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = 100;
const KV_KEY_PREFIX = "admin:ratelimit:";

interface KVRecord { timestamps: number[]; }

function getKvKey(adminId: string): string {
  return `${KV_KEY_PREFIX}${adminId}`;
}

/**
 * 非 KV 平台（EdgeOne/Vercel/纯 Node）的进程内滑动窗口兜底。
 * 单实例有效；多副本部署时各自计数（仍有基本防护，强度弱于 KV 全局窗口）。
 * 管理员数量极少，Map 不会膨胀。
 */
const memoryWindows = new Map<string, number[]>();

/** 进程内窗口检查：true 表示放行，false 表示已发送 429 */
function checkMemoryWindow(adminId: string, res: NextApiResponse): boolean {
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  const timestamps = (memoryWindows.get(adminId) || []).filter((ts) => ts > windowStart);

  if (timestamps.length >= MAX_REQUESTS) {
    const resetAt = new Date(timestamps[0] + WINDOW_MS).toISOString();
    res.setHeader("Retry-After", String(Math.ceil((timestamps[0] + WINDOW_MS - now) / 1000)));
    res.status(429).json({
      success: false,
      error: "管理 API 请求过于频繁（100 次/分钟），请稍后再试",
      resetAt,
    });
    return false;
  }

  timestamps.push(now);
  memoryWindows.set(adminId, timestamps);
  return true;
}

/**
 * 检查管理 API 速率限制
 *
 * @returns true 表示允许，false 表示已被限流（已发送 429 响应）
 */
export async function checkAdminRateLimit(
  adminId: string,
  res: NextApiResponse
): Promise<boolean> {
  // 动态加载 CF 运行时 API：仅 Cloudflare 平台（Pages/本地 CF 模拟）启用 KV 限流，
  // 其他平台（EdgeOne/Vercel/纯 Node）没有 @opennextjs/cloudflare 运行时依赖，降级为不限流
  let kv: KVNamespace | undefined;
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const { env } = getCloudflareContext();
    kv = env.KV;
  } catch { /* 本地开发或非 CF 环境 */ }

  if (!kv) {
    // 非 CF 平台：进程内滑动窗口兜底（原来直接放行 → 无限流）
    return checkMemoryWindow(adminId, res);
  }

  const key = getKvKey(adminId);
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  try {
    const raw = await kv.get(key);
    const record: KVRecord = raw ? JSON.parse(raw) : { timestamps: [] };
    const recent = record.timestamps.filter((ts) => ts > windowStart);

    if (recent.length >= MAX_REQUESTS) {
      const resetAt = new Date(recent[0] + WINDOW_MS).toISOString();
      res.setHeader("Retry-After", String(Math.ceil((recent[0] + WINDOW_MS - now) / 1000)));
      res.status(429).json({
        success: false,
        error: "管理 API 请求过于频繁（100 次/分钟），请稍后再试",
        resetAt,
      });
      return false;
    }

    recent.push(now);
    await kv.put(key, JSON.stringify({ timestamps: recent }), {
      expirationTtl: Math.ceil(WINDOW_MS / 1000) + 10,
    });

    return true;
  } catch {
    // KV 异常不阻塞请求
    return true;
  }
}
