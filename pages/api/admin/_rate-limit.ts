/**
 * 管理 API 全局速率限制（KV 滑动窗口）
 *
 * 用法：在 API handler 开头调用 await checkAdminRateLimit(adminId, res)
 * 如果被限流，函数会直接返回 false 并发送 429 响应
 *
 * 配置：100 次/分钟/管理员
 */

import type { NextApiResponse } from "next";
import { getCloudflareContext } from "@opennextjs/cloudflare";

const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = 100;
const KV_KEY_PREFIX = "admin:ratelimit:";

interface KVRecord { timestamps: number[]; }

function getKvKey(adminId: string): string {
  return `${KV_KEY_PREFIX}${adminId}`;
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
  let kv: KVNamespace | undefined;
  try {
    const { env } = getCloudflareContext();
    kv = env.KV;
  } catch { /* 本地开发或非 CF 环境 */ }

  if (!kv) return true;

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
