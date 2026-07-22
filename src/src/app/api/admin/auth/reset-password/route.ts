import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// 密码重置速率限制（24小时内最多3次，基于 IP）
const resetAttempts = new Map<string, { count: number; resetAt: number }>();
const RESET_RATE_LIMIT = 3;
const RESET_RATE_WINDOW = 24 * 60 * 60 * 1000; // 24小时

// 定期清理过期条目，防止内存泄漏
const globalForResetCleanup = globalThis as unknown as { __resetCleanupTimer?: ReturnType<typeof setInterval> };
if (!globalForResetCleanup.__resetCleanupTimer) {
  globalForResetCleanup.__resetCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of resetAttempts.entries()) {
      if (now > entry.resetAt) {
        resetAttempts.delete(key);
      }
    }
  }, 60 * 60 * 1000);
}

function checkResetRateLimit(ip: string): boolean {
  const now = Date.now();
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

const FLAG_KEY = "admin_reset_password";

/**
 * POST /api/admin/auth/reset-password — 请求重置管理员密码
 *
 * 写入数据库标志 admin_reset_password = "pending"
 * 下次服务启动时读取此标志，使用 ADMIN_PASSWORD 环境变量强制更新密码
 *
 * 安全约束（无需登录即可访问）：
 * - IP 级别速率限制：24小时内最多3次
 * - 仅当数据库中恰好有1个管理员时允许操作
 * - 环境变量 ADMIN_USERNAME 必须与现有管理员匹配
 */
export async function POST(request: Request) {
  // IP 级别速率限制
  const ip = request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "unknown";
  if (!checkResetRateLimit(ip)) {
    return NextResponse.json(
      { success: false, error: "密码重置请求过于频繁，请24小时后再试" },
      { status: 429 }
    );
  }

  try {
    const adminCount = await prisma.admin.count();

    if (adminCount === 0) {
      return NextResponse.json(
        {
          success: false,
          error: "数据库中无管理员账户，请通过 ADMIN_USERNAME / ADMIN_PASSWORD 环境变量创建",
        },
        { status: 400 }
      );
    }

    if (adminCount > 1) {
      return NextResponse.json(
        {
          success: false,
          error: `数据库中存在 ${adminCount} 个管理员账户，无法自动重置密码。请将所有管理员统一为一个，或手动修改数据库`,
        },
        { status: 400 }
      );
    }

    // 检查环境变量是否配置
    const envUsername = process.env.ADMIN_USERNAME;
    const envPassword = process.env.ADMIN_PASSWORD;

    if (!envUsername || !envPassword) {
      return NextResponse.json(
        {
          success: false,
          error: "未配置 ADMIN_USERNAME 或 ADMIN_PASSWORD 环境变量，无法重置密码",
        },
        { status: 400 }
      );
    }

    // 检查环境变量用户名与现有管理员是否匹配
    const admin = await prisma.admin.findFirst();
    if (admin && admin.username !== envUsername) {
      return NextResponse.json(
        {
          success: false,
          error: "管理员用户名与环境变量配置不匹配，请修改 ADMIN_USERNAME 环境变量使其与数据库中现有管理员一致后重试",
        },
        { status: 400 }
      );
    }

    // 写入重置标志
    await prisma.config.upsert({
      where: { key: FLAG_KEY },
      update: { value: "pending", updatedAt: new Date() },
      create: { key: FLAG_KEY, value: "pending" },
    });

    // 记录系统事件
    await prisma.systemEvent.create({
      data: {
        level: "info",
        message: "密码重置请求已提交",
        detail: JSON.stringify({
          adminUsername: admin?.username,
          timestamp: new Date().toISOString(),
        }),
      },
    });

    return NextResponse.json({
      success: true,
      message: "密码重置标志已写入，服务将在下次启动时自动更新密码",
    });
  } catch (error) {
    // 服务端记录错误详情，不向客户端泄露，仅输出错误信息避免泄露堆栈
    console.error("密码重置请求处理异常:", error instanceof Error ? error.message : String(error));
    return NextResponse.json(
      {
        success: false,
        error: "提交密码重置请求失败",
      },
      { status: 500 }
    );
  }
}
