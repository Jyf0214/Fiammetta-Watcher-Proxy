import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/auth";

// 密码重置速率限制（24小时内最多3次）
const resetAttempts = new Map<string, { count: number; resetAt: number }>();
const RESET_RATE_LIMIT = 3;
const RESET_RATE_WINDOW = 24 * 60 * 60 * 1000; // 24小时

function checkResetRateLimit(adminId: string): boolean {
  const now = Date.now();
  const entry = resetAttempts.get(adminId);
  if (!entry || now > entry.resetAt) {
    resetAttempts.set(adminId, { count: 1, resetAt: now + RESET_RATE_WINDOW });
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
 * 安全约束：
 * - 仅已登录管理员可发起密码重置
 * - 若数据库中存在多个管理员，拒绝操作（需手动统一管理员名称）
 * - 若环境变量 ADMIN_USERNAME 与现有管理员不匹配，拒绝操作
 */
export async function POST() {
  // 身份验证：仅管理员可发起密码重置
  const adminAuth = await getAdminFromRequest();
  if (!adminAuth) {
    return NextResponse.json(
      { success: false, error: "未授权" },
      { status: 401 }
    );
  }

  // 速率限制：24小时内最多3次密码重置
  if (!checkResetRateLimit(adminAuth.adminId)) {
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
    // 服务端记录错误详情，不向客户端泄露
    console.error("密码重置请求处理异常:", error);
    return NextResponse.json(
      {
        success: false,
        error: "提交密码重置请求失败",
      },
      { status: 500 }
    );
  }
}
