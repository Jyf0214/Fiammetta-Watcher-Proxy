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
import { eq } from "drizzle-orm";
import { createDb, type Database } from "@/lib/db";
import * as schema from "@/lib/schema";

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
    const db: Database = await createDb();
    const rows = await db
      .select({
        id: schema.systemApiKeys.id,
        name: schema.systemApiKeys.name,
        enabled: schema.systemApiKeys.enabled,
      })
      .from(schema.systemApiKeys)
      .where(eq(schema.systemApiKeys.key, key))
      .limit(1);

    if (rows.length === 0 || !rows[0].enabled) return null;

    // 更新 last_used_at（异步，不阻塞请求）
    const now = Math.floor(Date.now() / 1000);
    db.update(schema.systemApiKeys)
      .set({ lastUsedAt: now } as any)
      .where(eq(schema.systemApiKeys.id, rows[0].id))
      .execute()
      .catch(() => {});

    return { systemKeyId: rows[0].id, name: rows[0].name };
  } catch {
    return null;
  }
}
