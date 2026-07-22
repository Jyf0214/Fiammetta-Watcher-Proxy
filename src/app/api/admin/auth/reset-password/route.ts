/**
 * 密码重置 API
 *
 * POST /api/auth/reset-password — 请求重置管理员密码
 *
 * 写入数据库标志 admin_reset_password = "pending"
 * 下次管理员登录时读取此标志，使用 ADMIN_PASSWORD 环境变量强制更新密码
 *
 * 安全约束（无需登录即可访问）：
 * - IP 级别速率限制：24 小时内最多 3 次
 * - 仅当数据库中恰好有 1 个管理员时允许操作
 * - 环境变量 ADMIN_USERNAME 必须与现有管理员匹配
 */

import { NextRequest } from "next/server";
import { eq, count } from "drizzle-orm";
import { createDb } from "@/lib/db";
import * as schema from "@/lib/schema";

// ==================== 声明 Edge Runtime ====================

// ==================== 速率限制（24 小时内最多 3 次，基于 IP） ====================

const resetAttempts = new Map<string, { count: number; resetAt: number }>();
const RESET_RATE_LIMIT = 3;
const RESET_RATE_WINDOW = 24 * 60 * 60 * 1000; // 24 小时

/**
 * 惰性清理过期条目
 * 每次请求时顺带执行，避免依赖 setInterval（Edge Runtime 限制）
 */
function cleanupResetAttempts() {
  const now = Date.now();
  for (const [key, entry] of resetAttempts.entries()) {
    if (now > entry.resetAt) {
      resetAttempts.delete(key);
    }
  }
}

/**
 * 检查 IP 级别速率限制
 * @returns true 表示允许，false 表示被限流
 */
function checkResetRateLimit(ip: string): boolean {
  const now = Date.now();

  // 惰性清理
  cleanupResetAttempts();

  const entry = resetAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    resetAttempts.set(ip, { count: 1, resetAt: now + RESET_RATE_WINDOW });
    return true;
  }
  if (entry.count >= RESET_RATE_LIMIT) {
    return false;
  }
  entry.count++;
  return true;
}

// ==================== POST /api/auth/reset-password ====================

export async function POST(
  request: NextRequest,
  
): Promise<Response> {
  const env = {
    JWT_SECRET: process.env.JWT_SECRET,
    DB: (process.env as unknown as { DB: D1Database }).DB,
    ADMIN_USERNAME: process.env.ADMIN_USERNAME,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    ENVIRONMENT: process.env.ENVIRONMENT,
  };

  // IP 级别速率限制
  const clientIp =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";

  if (!checkResetRateLimit(clientIp)) {
    return Response.json(
      { success: false, error: "密码重置请求过于频繁，请 24 小时后再试" },
      { status: 429 }
    );
  }

  // 环境变量检查
  if (!env.DB) {
    return Response.json(
      { success: false, error: "数据库未配置" },
      { status: 500 }
    );
  }

  try {
    const db = createDb(env.DB);

    // 检查管理员数量
    const [adminCountResult] = await db
      .select({ total: count() })
      .from(schema.admins);

    const adminCount = adminCountResult?.total ?? 0;

    if (adminCount === 0) {
      return Response.json(
        {
          success: false,
          error:
            "数据库中无管理员账户，请通过 ADMIN_USERNAME / ADMIN_PASSWORD 环境变量创建",
        },
        { status: 400 }
      );
    }

    if (adminCount > 1) {
      return Response.json(
        {
          success: false,
          error: `数据库中存在 ${adminCount} 个管理员账户，无法自动重置密码。请将所有管理员统一为一个，或手动修改数据库`,
        },
        { status: 400 }
      );
    }

    // 检查环境变量是否配置
    const envUsername = env.ADMIN_USERNAME;
    const envPassword = env.ADMIN_PASSWORD;

    if (!envUsername || !envPassword) {
      return Response.json(
        {
          success: false,
          error:
            "未配置 ADMIN_USERNAME 或 ADMIN_PASSWORD 环境变量，无法重置密码",
        },
        { status: 400 }
      );
    }

    // 检查环境变量用户名与现有管理员是否匹配
    const [admin] = await db
      .select()
      .from(schema.admins)
      .limit(1);

    if (admin && admin.username !== envUsername) {
      return Response.json(
        {
          success: false,
          error:
            "管理员用户名与环境变量配置不匹配，请修改 ADMIN_USERNAME 环境变量使其与数据库中现有管理员一致后重试",
        },
        { status: 400 }
      );
    }

    // 写入重置标志（使用 upsert 语义：先尝试插入，若已存在则更新）
    const now = Math.floor(Date.now() / 1000);
    const [existingFlag] = await db
      .select()
      .from(schema.configs)
      .where(eq(schema.configs.key, "admin_reset_password"))
      .limit(1);

    if (existingFlag) {
      await db
        .update(schema.configs)
        .set({ value: "pending", updatedAt: now } as any)
        .where(eq(schema.configs.key, "admin_reset_password"));
    } else {
      await db.insert(schema.configs).values({
        key: "admin_reset_password",
        value: "pending",
        updatedAt: now,
      } as any);
    }

    // 记录系统事件
    try {
      await db.insert(schema.systemEvents).values({
        id: crypto.randomUUID(),
        level: "info",
        message: "密码重置请求已提交",
        detail: JSON.stringify({
          adminUsername: admin?.username,
          timestamp: new Date().toISOString(),
        }),
        createdAt: now,
      } as any);
    } catch {
      // 系统事件写入失败不阻塞主流程
    }

    return Response.json({
      success: true,
      message: "密码重置标志已写入，服务将在下次登录时自动更新密码",
    });
  } catch (error) {
    console.error(
      "密码重置请求处理异常:",
      error instanceof Error ? error.message : String(error)
    );
    return Response.json(
      { success: false, error: "提交密码重置请求失败" },
      { status: 500 }
    );
  }
}
