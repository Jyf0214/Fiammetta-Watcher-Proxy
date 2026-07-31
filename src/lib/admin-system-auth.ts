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

    // 更新 last_used_at（异步，不阻塞请求）
    const now = Math.floor(Date.now() / 1000);
    db.systemApiKeys.update({
      where: { id: row.id },
      data: { lastUsedAt: now },
    }).catch(() => {});

    return { systemKeyId: row.id, name: row.name };
  } catch {
    return null;
  }
}
