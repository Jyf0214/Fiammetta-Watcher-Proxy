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
import { validateSystemApiKey } from "./_system-auth";

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
 * system-key 认证时返回 null（系统 Key 不在 admins 表中，外键约束会失败）
 */
export function getAuditAdminId(admin: AuthResult): string | null {
  return admin.authMethod === "system-key" ? null : admin.adminId;
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
