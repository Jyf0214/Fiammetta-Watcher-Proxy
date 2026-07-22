/**
 * Pages Router 管理员认证工具
 *
 * 从 NextApiRequest 的 Cookie 中提取 admin_token，
 * 验证 JWT 并返回管理员身份信息。
 */

import type { NextApiRequest } from "next";
import { verifyToken } from "@/lib/auth";

/**
 * 从请求中提取管理员身份
 */
export async function getAdminFromRequest(
  req: NextApiRequest
): Promise<{ adminId: string; username: string } | null> {
  try {
    const token = req.cookies["admin_token"];
    if (!token) return null;

    const payload = await verifyToken(token);
    if (!payload || !payload.adminId || !payload.username) return null;

    return { adminId: payload.adminId as string, username: payload.username as string };
  } catch {
    return null;
  }
}
