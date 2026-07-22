/**
 * 认证 API — 登录 / 登出 / 获取当前管理员信息
 *
 * POST   /api/auth  — 管理员登录（验证用户名密码 → 生成 JWT → 设置 Cookie）
 * DELETE /api/auth  — 管理员登出（清除 Cookie + 审计日志）
 * GET    /api/auth  — 获取当前登录管理员信息
 */

import { NextRequest } from "next/server";
import { eq, count } from "drizzle-orm";
import {
  generateToken,
  verifyToken,
  setAuthCookie,
  clearAuthCookie,
  getTokenFromCookie,
  hashPassword,
  type AdminPayload,
} from "@/lib/auth";
import { verifyPassword } from "@/lib/auth-helpers";
import { createDb } from "@/lib/db";
import * as schema from "@/lib/schema";

// ==================== 声明 Edge Runtime ====================

// ==================== 速率限制（登录失败防暴力） ====================
// Pages Functions 每次请求独立执行，使用惰性清理策略

interface LoginAttemptEntry {
  count: number;
  windowStart: number;
}

/** 每个 IP 的登录失败尝试记录 */
const loginAttempts = new Map<string, LoginAttemptEntry>();

/** 每个 IP 最多允许的登录失败次数 */
const LOGIN_MAX_ATTEMPTS = 5;
/** 限流窗口时长（15 分钟） */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/**
 * 惰性清理过期条目
 * 每次请求时顺带执行，避免依赖 setInterval（Edge Runtime 限制）
 */
function cleanupLoginAttempts() {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts.entries()) {
    if (now - entry.windowStart >= LOGIN_WINDOW_MS) {
      loginAttempts.delete(ip);
    }
  }
}

/**
 * 原子化检查并递增登录失败计数
 *
 * 将「检查是否超限」和「递增计数」合为一步操作，
 * 避免两个并发请求同时通过检查后都执行登录的竞态条件。
 *
 * @returns null 表示允许，否则返回错误响应
 */
function checkAndRecordLoginAttempt(
  ip: string
): Response | null {
  const now = Date.now();

  // 惰性清理
  cleanupLoginAttempts();

  let entry = loginAttempts.get(ip);

  // 窗口过期，重置
  if (!entry || now - entry.windowStart >= LOGIN_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
    loginAttempts.set(ip, entry);
  }

  // 先递增再检查：确保并发请求不会同时通过
  entry.count += 1;

  if (entry.count > LOGIN_MAX_ATTEMPTS) {
    const resetAt = new Date(entry.windowStart + LOGIN_WINDOW_MS).toISOString();
    return Response.json(
      {
        success: false,
        error: "登录尝试次数过多，请稍后再试",
        resetAt,
      },
      { status: 429 }
    );
  }

  return null;
}

/** 登录成功，清除该 IP 的失败计数 */
function clearLoginFailures(ip: string): void {
  loginAttempts.delete(ip);
}

// ==================== 工具函数 ====================

/** 从请求中提取客户端 IP */
function getClientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

/** 从请求中提取管理员身份 */
async function getAdmin(
  request: NextRequest,
  env: { JWT_SECRET?: string; DB: D1Database }
): Promise<AdminPayload | null> {
  const token = getTokenFromCookie(request);
  if (!token) return null;

  const payload = await verifyToken(token, env);
  if (!payload) return null;

  // 验证管理员是否仍然存在于数据库中
  try {
    const db = createDb(env.DB);
    const [admin] = await db
      .select({ id: schema.admins.id })
      .from(schema.admins)
      .where(eq(schema.admins.id, payload.adminId))
      .limit(1);

    if (!admin) return null;
  } catch {
    return null;
  }

  return payload;
}

/** 检查环境变量 */
function checkEnv(env: {
  JWT_SECRET?: string;
  DB: D1Database;
}): Response | null {
  if (!env.JWT_SECRET) {
    return Response.json(
      { success: false, error: "JWT_SECRET 环境变量未配置" },
      { status: 500 }
    );
  }
  if (!env.DB) {
    return Response.json(
      { success: false, error: "数据库未配置" },
      { status: 500 }
    );
  }
  return null;
}

// ==================== POST /api/auth — 管理员登录 ====================

export async function POST(
  request: NextRequest,
  context: { env: { JWT_SECRET?: string; DB: D1Database; ADMIN_USERNAME?: string; ADMIN_PASSWORD?: string; ENVIRONMENT?: string } }
): Promise<Response> {
  const env = context.env;

  // 环境变量检查
  const envError = checkEnv(env);
  if (envError) return envError;

  try {
    const clientIp = getClientIp(request);

    // 原子化限流检查 + 递增，避免并发绕过限制
    const rateLimitResponse = checkAndRecordLoginAttempt(clientIp);
    if (rateLimitResponse) return rateLimitResponse;

    // 解析请求体
    let body: { username?: string; password?: string };
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { success: false, error: "请求格式错误" },
        { status: 400 }
      );
    }

    const { username, password } = body;

    if (!username || !password) {
      return Response.json(
        { success: false, error: "用户名和密码不能为空" },
        { status: 400 }
      );
    }

    const db = createDb(env.DB);

    // 查询管理员
    const [admin] = await db
      .select()
      .from(schema.admins)
      .where(eq(schema.admins.username, username))
      .limit(1);

    if (!admin) {
      // 用户名不存在，执行一次假哈希以防止时序攻击泄露用户名是否存在
      await hashPassword("dummy");
      return Response.json(
        { success: false, error: "用户名或密码错误" },
        { status: 401 }
      );
    }

    // 验证密码
    const valid = await verifyPassword(password, admin.passwordHash);

    if (!valid) {
      // 记录登录失败审计日志
      try {
        await db.insert(schema.auditLogs).values({
          id: crypto.randomUUID(),
          adminId: admin.id,
          action: "login_failed",
          detail: JSON.stringify({ username: admin.username }),
          ip: clientIp,
          createdAt: Math.floor(Date.now() / 1000),
        } as any);
      } catch {
        // 审计日志写入失败不阻塞主流程
      }

      return Response.json(
        { success: false, error: "用户名或密码错误" },
        { status: 401 }
      );
    }

    // ==================== 密码重置标志处理 ====================
    // 密码验证通过后，检查是否存在 admin_reset_password 待处理标志
    const [resetFlag] = await db
      .select()
      .from(schema.configs)
      .where(eq(schema.configs.key, "admin_reset_password"))
      .limit(1);

    if (resetFlag && resetFlag.value === "pending") {
      const envUsername = env.ADMIN_USERNAME;
      const envPassword = env.ADMIN_PASSWORD;

      if (envPassword && envUsername && admin.username === envUsername) {
        try {
          const newHash = await hashPassword(envPassword);
          await db
            .update(schema.admins)
            .set({
              passwordHash: newHash,
              updatedAt: Math.floor(Date.now() / 1000),
            } as any)
            .where(eq(schema.admins.id, admin.id));

          await db
            .delete(schema.configs)
            .where(eq(schema.configs.key, "admin_reset_password"));
        } catch (e) {
          console.error("[auth] 密码重置处理失败:", e);
        }
      } else {
        // 环境变量不匹配或未配置，清除标志
        await db
          .delete(schema.configs)
          .where(eq(schema.configs.key, "admin_reset_password"));
      }
    }

    // 清除登录失败计数
    clearLoginFailures(clientIp);

    // 生成 JWT Token
    const isProd = env.ENVIRONMENT === "production";
    const token = await generateToken(
      { adminId: admin.id, username: admin.username },
      env
    );

    // 构建响应并设置 Cookie
    const response = Response.json({
      success: true,
      data: { username: admin.username },
      message: "登录成功",
    });

    const responseWithCookie = setAuthCookie(response, token, isProd);

    // 记录登录成功审计日志
    try {
      await db.insert(schema.auditLogs).values({
        id: crypto.randomUUID(),
        adminId: admin.id,
        action: "login",
        detail: JSON.stringify({ username: admin.username }),
        ip: clientIp,
        createdAt: Math.floor(Date.now() / 1000),
      } as any);
    } catch {
      // 审计日志写入失败不阻塞主流程
    }

    return responseWithCookie;
  } catch (error) {
    console.error(
      "[auth] 登录异常:",
      error instanceof Error ? error.message : String(error)
    );
    return Response.json(
      { success: false, error: "登录失败" },
      { status: 500 }
    );
  }
}

// ==================== DELETE /api/auth — 管理员登出 ====================

export async function DELETE(
  request: NextRequest,
  context: { env: { JWT_SECRET?: string; DB: D1Database; ENVIRONMENT?: string } }
): Promise<Response> {
  const env = context.env;

  try {
    const admin = await getAdmin(request, env);
    const clientIp = getClientIp(request);

    // 构建响应并清除 Cookie
    const response = Response.json({
      success: true,
      message: "已退出登录",
    });

    const responseWithCookie = clearAuthCookie(response);

    // 记录登出审计日志
    if (admin) {
      try {
        const db = createDb(env.DB);
        await db.insert(schema.auditLogs).values({
          id: crypto.randomUUID(),
          adminId: admin.adminId,
          action: "logout",
          detail: JSON.stringify({ username: admin.username }),
          ip: clientIp,
          createdAt: Math.floor(Date.now() / 1000),
        } as any);
      } catch {
        // 审计日志写入失败不阻塞主流程
      }
    }

    return responseWithCookie;
  } catch (err) {
    console.error("[DELETE /api/auth] 登出异常:", err);

    // 即使出错也清除 Cookie
    const response = Response.json(
      { success: false, error: "登出过程中发生错误，但登录状态已清除" },
      { status: 500 }
    );

    return clearAuthCookie(response);
  }
}

// ==================== GET /api/auth — 获取当前管理员信息 ====================

export async function GET(
  request: NextRequest,
  context: { env: { JWT_SECRET?: string; DB: D1Database } }
): Promise<Response> {
  const env = context.env;

  const envError = checkEnv(env);
  if (envError) return envError;

  try {
    const admin = await getAdmin(request, env);
    if (!admin) {
      return Response.json(
        { success: false, error: "未授权" },
        { status: 401 }
      );
    }

    return Response.json({
      success: true,
      data: { adminId: admin.adminId, username: admin.username },
    });
  } catch (err) {
    console.error("[GET /api/auth] 获取管理员信息失败:", err);
    return Response.json(
      { success: false, error: "未授权" },
      { status: 401 }
    );
  }
}
