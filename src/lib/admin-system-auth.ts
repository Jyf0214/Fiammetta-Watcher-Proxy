/**
 * 系统 API Key 认证工具
 *
 * 从 Authorization: Bearer <key> 头提取 Key，
 * 验证是否为有效的系统级 API Key（system_api_keys 表）。
 *
 * 与 v1 代理 API Key（api_keys 表）完全隔离：
 * - 系统 Key 仅用于管理后台 API（/api/admin/*）
 * - v1 Key 仅用于代理转发（Worker 处理）
 */

import type { NextApiRequest } from "next";
import { createDb } from "@/lib/prisma";

/** 系统 Key 认证结果 */
export interface SystemAuthResult {
  systemKeyId: string;
  name: string;
}

/**
 * 从请求中提取并验证系统 API Key
 *
 * @param req - NextApiRequest
 * @returns 认证成功返回 { systemKeyId, name }，失败返回 null
 */
export async function validateSystemApiKey(
  req: NextApiRequest
): Promise<SystemAuthResult | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;

  const key = authHeader.slice(7).trim();
  if (!key) return null;

  try {
    const db = await createDb();
    const row = await db.systemApiKeys.findFirst({
      where: { key },
      select: { id: true, name: true, enabled: true },
    });

    if (!row || !row.enabled) return null;

    // 更新 last_used_at：必须 await——CF Pages 边缘运行时在响应返回后不保证
    // 未完成的异步 promise 继续执行（fire-and-forget 可能被直接丢弃，
    // system-keys 列表「最近使用」在 Cloudflare 部署下恒不更新）。
    // 更新失败仅记录日志，不阻断认证主流程
    const now = Math.floor(Date.now() / 1000);
    try {
      await db.systemApiKeys.update({
        where: { id: row.id },
        data: { lastUsedAt: now },
      });
    } catch (err) {
      console.error(
        "[admin-system-auth] lastUsedAt 更新失败:",
        err instanceof Error ? err.message : String(err)
      );
    }

    return { systemKeyId: row.id, name: row.name };
  } catch {
    return null;
  }
}
