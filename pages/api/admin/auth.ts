/**
 * 认证 API — 登录 / 登出 / 获取当前管理员信息
 *
 * POST   /api/admin/auth  — 管理员登录（验证用户名密码 → 生成 JWT → 设置 Cookie）
 * DELETE /api/admin/auth  — 管理员登出（清除 Cookie + 审计日志）
 * GET    /api/admin/auth  — 获取当前登录管理员信息
 *
 * 主分支对应文件：src/app/api/admin/auth/route.ts
 * Pages Router 格式转换
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { generateToken, verifyToken, type AdminPayload } from "@/lib/auth";
import { createDb } from "@/lib/db";
import * as schema from "@/lib/schema";
import { getAuditAdminId, type AuthResult } from "./_auth";

const COOKIE_NAME = "admin_token";

// ==================== 速率限制（登录失败防暴力） ====================

interface LoginAttemptEntry { count: number; windowStart: number; }
const loginAttempts = new Map<string, LoginAttemptEntry>();
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function cleanupLoginAttempts() {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts.entries()) {
    if (now - entry.windowStart >= LOGIN_WINDOW_MS) loginAttempts.delete(ip);
  }
}

function checkAndRecordLoginAttempt(ip: string): boolean {
  const now = Date.now();
  cleanupLoginAttempts();
  let entry = loginAttempts.get(ip);
  if (!entry || now - entry.windowStart >= LOGIN_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
    loginAttempts.set(ip, entry);
  }
  entry.count += 1;
  return entry.count > LOGIN_MAX_ATTEMPTS;
}

function clearLoginFailures(ip: string): void { loginAttempts.delete(ip); }

// ==================== 工具函数 ====================

function getClientIp(req: NextApiRequest): string {
  const forwarded = req.headers["x-forwarded-for"];
  const str = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return str?.split(",")[0]?.trim() || (req.headers["x-real-ip"] as string) || "unknown";
}

function getTokenFromCookie(req: NextApiRequest): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  for (const cookie of cookieHeader.split(";")) {
    const [name, ...rest] = cookie.trim().split("=");
    if (name === COOKIE_NAME) return rest.join("=");
  }
  return null;
}

function setAuthCookie(res: NextApiResponse, token: string, isProd: boolean): void {
  const cookie = [`${COOKIE_NAME}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax",
    `Max-Age=${7 * 24 * 60 * 60}`, isProd ? "Secure" : ""].filter(Boolean).join("; ");
  res.setHeader("Set-Cookie", cookie);
}

function clearAuthCookie(res: NextApiResponse): void {
  const cookie = [`${COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"].join("; ");
  res.setHeader("Set-Cookie", cookie);
}

async function getAdmin(req: NextApiRequest, env: { JWT_SECRET?: string }): Promise<AdminPayload | null> {
  const token = getTokenFromCookie(req);
  if (!token) return null;
  const payload = await verifyToken(token, env);
  if (!payload) return null;
  return payload;
}

// ==================== Handler ====================

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  switch (req.method) {
    case "POST": return handleLogin(req, res);
    case "DELETE": return handleLogout(req, res);
    case "GET": return handleGetAdmin(req, res);
    default:
      res.setHeader("Allow", ["GET", "POST", "DELETE"]);
      return res.status(405).json({ success: false, error: "Method not allowed" });
  }
}

// ==================== POST — 管理员登录 ====================

async function handleLogin(req: NextApiRequest, res: NextApiResponse) {
  const env = {
    JWT_SECRET: process.env.JWT_SECRET,
    ADMIN_USERNAME: process.env.ADMIN_USERNAME,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    ENVIRONMENT: process.env.ENVIRONMENT,
  };
  if (!env.JWT_SECRET) return res.status(500).json({ success: false, error: "JWT_SECRET 环境变量未配置" });
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) {
    return res.status(500).json({ success: false, error: "管理员账号未配置（ADMIN_USERNAME / ADMIN_PASSWORD）" });
  }

  try {
    const clientIp = getClientIp(req);
    if (checkAndRecordLoginAttempt(clientIp)) {
      const entry = loginAttempts.get(clientIp);
      const resetAt = entry ? new Date(entry.windowStart + LOGIN_WINDOW_MS).toISOString() : new Date().toISOString();
      return res.status(429).json({ success: false, error: "登录尝试次数过多，请稍后再试", resetAt });
    }

    const body = req.body as { username?: string; password?: string } | undefined;
    if (!body || typeof body !== "object") return res.status(400).json({ success: false, error: "请求格式错误" });

    const { username, password } = body;
    if (!username || !password) return res.status(400).json({ success: false, error: "用户名和密码不能为空" });

    // 直接比对环境变量中的用户名和密码
    if (username !== env.ADMIN_USERNAME || password !== env.ADMIN_PASSWORD) {
      return res.status(401).json({ success: false, error: "用户名或密码错误" });
    }

    clearLoginFailures(clientIp);
    const isProd = env.ENVIRONMENT === "production";
    const token = await generateToken({ adminId: "env-admin", username: env.ADMIN_USERNAME! }, env);
    setAuthCookie(res, token, isProd);

    return res.status(200).json({ success: true, data: { username: env.ADMIN_USERNAME }, message: "登录成功" });
  } catch (error) {
    console.error("[auth] 登录异常:", error instanceof Error ? error.message : String(error));
    return res.status(500).json({ success: false, error: "登录失败", detail: error instanceof Error ? error.message : String(error) });
  }
}

// ==================== DELETE — 管理员登出 ====================

async function handleLogout(req: NextApiRequest, res: NextApiResponse) {
  const env = {
    JWT_SECRET: process.env.JWT_SECRET,
    ADMIN_USERNAME: process.env.ADMIN_USERNAME,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    ENVIRONMENT: process.env.ENVIRONMENT,
  };

  try {
    const admin = await getAdmin(req, env);
    const clientIp = getClientIp(req);
    clearAuthCookie(res);

    if (admin) {
      try {
        const db = await createDb();
        await db.insert(schema.auditLogs).values({
          id: crypto.randomUUID(), adminId: getAuditAdminId(admin as AuthResult), action: "logout",
          detail: JSON.stringify({ username: admin.username }), ip: clientIp, createdAt: Math.floor(Date.now() / 1000),
        } as any);
      } catch { /* 审计日志写入失败不阻塞主流程 */ }
    }

    return res.status(200).json({ success: true, message: "已退出登录" });
  } catch (err) {
    console.error("[DELETE /api/admin/auth] 登出异常:", err);
    clearAuthCookie(res);
    return res.status(500).json({ success: false, error: "登出过程中发生错误，但登录状态已清除", detail: err instanceof Error ? err.message : String(err) });
  }
}

// ==================== GET — 获取当前管理员信息 ====================

async function handleGetAdmin(req: NextApiRequest, res: NextApiResponse) {
  const env = {
    JWT_SECRET: process.env.JWT_SECRET,
    ADMIN_USERNAME: process.env.ADMIN_USERNAME,
  };
  if (!env.JWT_SECRET) return res.status(500).json({ success: false, error: "JWT_SECRET 环境变量未配置" });

  try {
    const admin = await getAdmin(req, env);
    if (!admin) return res.status(401).json({ success: false, error: "未授权" });
    return res.status(200).json({ success: true, data: { adminId: admin.adminId, username: admin.username } });
  } catch (err) {
    console.error("[GET /api/admin/auth] 获取管理员信息失败:", err);
    return res.status(401).json({ success: false, error: "未授权", detail: err instanceof Error ? err.message : String(err) });
  }
}
