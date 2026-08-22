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

/** 常量时间字符串比较，防止时序侧信道攻击 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  // 不等长时也做完整异或遍历，避免提前短路泄露长度信息
  const maxLen = Math.max(bufA.length, bufB.length);
  let result = bufA.length ^ bufB.length;
  for (let i = 0; i < maxLen; i++) {
    result |= (bufA[i] ?? 0) ^ (bufB[i] ?? 0);
  }
  return result === 0;
}

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

    // 按 key 查找记录（数据库层按 key 字段精确匹配）
    const row = await db.systemApiKeys.findFirst({
      where: { key },
      select: { id: true, key: true, name: true, enabled: true },
    });

    // 用常量时间比较确认 key 匹配，防止时序侧信道：
    // 即使数据库查询结果已区分「有记录/无记录」，
    // 此处对两种情况都执行一次 timingSafeStringEqual，
    // 使攻击者无法通过响应时间差异推断"记录不存在"vs"密钥错误"。
    const dummyKey = "0000000000000000000000000000000000000000000000000000000000000000";
    const keyToCompare = row?.key ?? dummyKey;
    const keyValid = timingSafeStringEqual(key, keyToCompare);

    if (!keyValid || !row?.enabled) return null;

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
