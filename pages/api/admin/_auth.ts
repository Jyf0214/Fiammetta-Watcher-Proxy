/**
 * Pages Router 管理员认证工具
 *
 * 支持两种认证方式：
 * 1. Cookie + JWT（浏览器会话，通过登录接口获取）
 * 2. Authorization: Bearer <system-api-key>（程序化调用，system_api_keys 表）
 *
 * 优先检查 Cookie+JWT，若无则尝试 Bearer 认证。
 */

import type { NextApiRequest } from "next";
import { verifyToken } from "@/lib/auth";
import { createDb } from "@/lib/prisma";
import { validateSystemApiKey } from "./_system-auth";

const COOKIE_NAME = "admin_token";

/** 从请求 Cookie 中提取指定名称的 cookie 值 */
export function getTokenFromCookie(req: NextApiRequest): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  for (const cookie of cookieHeader.split(";")) {
    const [name, ...rest] = cookie.trim().split("=");
    if (name === COOKIE_NAME) return rest.join("=");
  }
  return null;
}

/** 统一认证结果 */
export interface AuthResult {
  /** adminId：JWT 登录时为 "env-admin"，系统 Key 时为 system key ID */
  adminId: string;
  /** username：JWT 登录时为管理员用户名，系统 Key 时为 key 名称 */
  username: string;
  /** 认证方式：jwt 或 system-key */
  authMethod: "jwt" | "system-key";
}

/**
 * 获取审计日志用的 adminId
 *
 * 返回 null 的情况（audit_logs 表有外键约束 REFERENCES admins(id)）：
 * - system-key 认证：系统 Key 不在 admins 表中
 * - JWT 认证且 adminId="env-admin"：env-admin 是 JWT 登录的虚拟 ID，不在 admins 表中
 */
export function getAuditAdminId(admin: AuthResult): string | null {
  if (admin.authMethod === "system-key") return null;
  if (admin.adminId === "env-admin") return null;
  return admin.adminId;
}

/**
 * 从请求中提取管理员身份
 *
 * 优先级：Cookie+JWT > Bearer system-api-key
 */
export async function getAdminFromRequest(
  req: NextApiRequest
): Promise<AuthResult | null> {
  // 1. 尝试 Cookie+JWT 认证
  try {
    const token = req.cookies["admin_token"];
    if (token) {
      const payload = await verifyToken(token, { JWT_SECRET: process.env.JWT_SECRET });
      if (payload && payload.adminId && payload.username) {
        // 验证 tokenVersion（吊销机制）
        if (payload.adminId === "env-admin") {
          try {
            const db = await createDb();
            const admin = await db.admins.findFirst({
              where: { username: payload.username as string },
              select: { tokenVersion: true },
            });
            if (admin && admin.tokenVersion !== ((payload as unknown as Record<string, unknown>).tokenVersion as number)) {
              return null; // token 已被吊销
            }
          } catch {
            // 数据库查询失败，放行（避免数据库问题导致所有请求被拒）
          }
        }
        return {
          adminId: payload.adminId as string,
          username: payload.username as string,
          authMethod: "jwt",
        };
      }
    }
  } catch {
    // JWT 验证失败，继续尝试 Bearer
  }

  // 2. 尝试 Bearer system-api-key 认证
  const systemAuth = await validateSystemApiKey(req);
  if (systemAuth) {
    return {
      adminId: systemAuth.systemKeyId,
      username: systemAuth.name,
      authMethod: "system-key",
    };
  }

  return null;
}

// Next.js 16 类型检查器将 pages/api/ 下所有文件视为路由，工具模块导出空 handler 避免误报
export default function _noop() {}
