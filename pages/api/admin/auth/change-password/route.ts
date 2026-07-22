/**
 * 密码修改 API
 *
 * POST /api/auth/change-password — 管理员修改密码
 *
 * 要求：管理员已登录（携带有效 Cookie），验证旧密码后修改为新密码。
 * 速率限制：5 次 / 15 分钟 / IP，防止暴力尝试。
 */

import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import {
  getTokenFromCookie,
  verifyToken,
  hashPassword,
} from "@/lib/auth";
import { verifyPassword } from "@/lib/auth-helpers";
import { createDb } from "@/lib/db";
import * as schema from "@/lib/schema";

// ==================== 声明 Edge Runtime ====================

// ==================== 速率限制（密码修改失败防暴力） ====================

interface ChangeAttemptEntry {
  count: number;
  windowStart: number;
}

/** 每个 IP 的密码修改失败尝试记录 */
const changeAttempts = new Map<string, ChangeAttemptEntry>();

/** 每个 IP 最多允许的密码修改失败次数 */
const CHANGE_MAX_ATTEMPTS = 5;
/** 限流窗口时长（15 分钟） */
const CHANGE_WINDOW_MS = 15 * 60 * 1000;

/**
 * 惰性清理过期条目
 * 每次请求时顺带执行，避免依赖 setInterval（Edge Runtime 限制）
 */
function cleanupChangeAttempts() {
  const now = Date.now();
  for (const [ip, entry] of changeAttempts.entries()) {
    if (now - entry.windowStart >= CHANGE_WINDOW_MS) {
      changeAttempts.delete(ip);
    }
  }
}

/**
 * 检查该 IP 是否被限流
 * 返回 null 表示允许，否则返回 429 响应
 */
function checkChangeRateLimit(ip: string): Response | null {
  const now = Date.now();

  // 惰性清理
  cleanupChangeAttempts();

  const entry = changeAttempts.get(ip);

  // 窗口已过期，重置
  if (!entry || now - entry.windowStart >= CHANGE_WINDOW_MS) {
    changeAttempts.set(ip, { count: 0, windowStart: now });
    return null;
  }

  if (entry.count >= CHANGE_MAX_ATTEMPTS) {
    const resetAt = new Date(entry.windowStart + CHANGE_WINDOW_MS).toISOString();
    return Response.json(
      {
        success: false,
        error: "密码修改尝试次数过多，请稍后再试",
        resetAt,
      },
      { status: 429 }
    );
  }

  return null;
}

/** 记录一次密码修改失败 */
function recordChangeFailure(ip: string): void {
  const now = Date.now();
  const entry = changeAttempts.get(ip);

  if (!entry || now - entry.windowStart >= CHANGE_WINDOW_MS) {
    changeAttempts.set(ip, { count: 1, windowStart: now });
  } else {
    entry.count += 1;
  }
}

/** 清除该 IP 的失败计数 */
function clearChangeFailures(ip: string): void {
  changeAttempts.delete(ip);
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

// ==================== POST /api/auth/change-password ====================

export async function POST(
  request: NextRequest,
  context: { env: { JWT_SECRET?: string; DB: D1Database; ENVIRONMENT?: string } }
): Promise<Response> {
  const env = context.env;

  // 环境变量检查
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

  try {
    const clientIp = getClientIp(request);

    // 速率限制检查
    const rateLimitResponse = checkChangeRateLimit(clientIp);
    if (rateLimitResponse) return rateLimitResponse;

    // 鉴权：验证管理员身份
    const token = getTokenFromCookie(request);
    if (!token) {
      return Response.json(
        { success: false, error: "未授权" },
        { status: 401 }
      );
    }

    const payload = await verifyToken(token, env);
    if (!payload) {
      return Response.json(
        { success: false, error: "登录已过期" },
        { status: 401 }
      );
    }

    // 解析请求体
    let body: {
      currentPassword?: string;
      newPassword?: string;
      confirmPassword?: string;
    };
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { success: false, error: "请求格式错误" },
        { status: 400 }
      );
    }

    const { currentPassword, newPassword, confirmPassword } = body;

    // 校验：三个字段都不能为空
    if (!currentPassword || !newPassword || !confirmPassword) {
      return Response.json(
        { success: false, error: "所有字段均为必填" },
        { status: 400 }
      );
    }

    // 校验：新密码长度至少 8 位，最多 128 位（DoS 防护）
    if (typeof newPassword !== "string" || newPassword.length < 8) {
      return Response.json(
        { success: false, error: "新密码至少需要 8 个字符" },
        { status: 400 }
      );
    }
    if (newPassword.length > 128) {
      return Response.json(
        { success: false, error: "新密码长度不能超过 128 个字符" },
        { status: 400 }
      );
    }

    // 校验：两次输入的新密码一致
    if (newPassword !== confirmPassword) {
      return Response.json(
        { success: false, error: "两次输入的新密码不一致" },
        { status: 400 }
      );
    }

    const db = createDb(env.DB);

    // 查询管理员完整记录（获取密码哈希）
    const [adminRecord] = await db
      .select()
      .from(schema.admins)
      .where(eq(schema.admins.id, payload.adminId))
      .limit(1);

    if (!adminRecord) {
      return Response.json(
        { success: false, error: "管理员账户不存在" },
        { status: 401 }
      );
    }

    // 验证旧密码
    const isValid = await verifyPassword(currentPassword, adminRecord.passwordHash);
    if (!isValid) {
      recordChangeFailure(clientIp);

      // 记录失败审计日志
      try {
        await db.insert(schema.auditLogs).values({
          id: crypto.randomUUID(),
          adminId: payload.adminId,
          action: "change_password_failed",
          detail: "当前密码错误",
          ip: clientIp,
          createdAt: Math.floor(Date.now() / 1000),
        } as any);
      } catch {
        // 审计日志写入失败不阻塞主流程
      }

      return Response.json(
        { success: false, error: "当前密码错误" },
        { status: 400 }
      );
    }

    // 生成新密码哈希
    const newHash = await hashPassword(newPassword);

    // 更新数据库中的密码
    await db
      .update(schema.admins)
      .set({
        passwordHash: newHash,
        updatedAt: Math.floor(Date.now() / 1000),
      } as any)
      .where(eq(schema.admins.id, payload.adminId));

    // 清除该 IP 的失败计数
    clearChangeFailures(clientIp);

    // 记录成功审计日志
    try {
      await db.insert(schema.auditLogs).values({
        id: crypto.randomUUID(),
        adminId: payload.adminId,
        action: "change_password",
        detail: "密码已修改",
        ip: clientIp,
        createdAt: Math.floor(Date.now() / 1000),
      } as any);
    } catch {
      // 审计日志写入失败不阻塞主流程
    }

    return Response.json({
      success: true,
      message: "密码修改成功",
    });
  } catch (error) {
    console.error(
      "[auth] 修改密码异常:",
      error instanceof Error ? error.message : String(error)
    );
    return Response.json(
      { success: false, error: "密码修改失败，请稍后重试" },
      { status: 500 }
    );
  }
}
