import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  generateToken,
  setAuthCookie,
  clearAuthCookie,
  verifyPassword,
  getAdminFromRequest,
} from "@/lib/auth";

// ---------- 登录速率限制（内存实现） ----------

interface LoginAttemptEntry {
  count: number;
  windowStart: number;
}

/** 每个 IP 的登录失败尝试记录 */
const loginAttempts = new Map<string, LoginAttemptEntry>();

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 分钟

/** 过期清理定时器 */
const LOGIN_CLEANUP_INTERVAL = 60_000;

function cleanupLoginAttempts() {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts.entries()) {
    if (now - entry.windowStart >= LOGIN_WINDOW_MS) {
      loginAttempts.delete(ip);
    }
  }
}

// 定期清理防止内存泄漏
setInterval(cleanupLoginAttempts, LOGIN_CLEANUP_INTERVAL);

/** 从请求中提取客户端 IP */
function getClientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

/** 检查该 IP 是否被限流，返回 null 表示允许，否则返回 429 响应 */
function checkLoginRateLimit(ip: string): NextResponse | null {
  const now = Date.now();
  const entry = loginAttempts.get(ip);

  // 窗口已过期，重置
  if (!entry || now - entry.windowStart >= LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 0, windowStart: now });
    return null;
  }

  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    const resetAt = new Date(entry.windowStart + LOGIN_WINDOW_MS).toISOString();
    return NextResponse.json(
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

/** 记录一次登录失败 */
function recordLoginFailure(ip: string): void {
  const now = Date.now();
  const entry = loginAttempts.get(ip);

  if (!entry || now - entry.windowStart >= LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, windowStart: now });
  } else {
    entry.count += 1;
  }
}

/** 登录成功，清除该 IP 的失败计数 */
function clearLoginFailures(ip: string): void {
  loginAttempts.delete(ip);
}

/**
 * POST /api/admin/auth — 管理员登录
 */
export async function POST(request: NextRequest) {
  try {
    const clientIp = getClientIp(request);

    // 速率限制检查
    const rateLimitResponse = checkLoginRateLimit(clientIp);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    const body = await request.json();
    const { username, password } = body;

    if (!username || !password) {
      return NextResponse.json(
        { success: false, error: "用户名和密码不能为空" },
        { status: 400 }
      );
    }

    // 检查是否存在管理员，不存在则从环境变量自动创建
    const adminCount = await prisma.admin.count();
    if (adminCount === 0) {
      const envUsername = process.env.ADMIN_USERNAME;
      const envPassword = process.env.ADMIN_PASSWORD;
      if (envUsername && envPassword) {
        try {
          const { hashPassword } = await import("@/lib/auth");
          const passwordHash = await hashPassword(envPassword);
          await prisma.admin.create({
            data: { username: envUsername, passwordHash },
          });
          console.log(`[auth] 首次登录自动创建管理员: ${envUsername}`);
        } catch (e) {
          console.error("[auth] 自动创建管理员失败:", e);
        }
      }
    }

    // 查找管理员
    const admin = await prisma.admin.findUnique({
      where: { username },
    });

    if (!admin) {
      recordLoginFailure(clientIp);
      return NextResponse.json(
        { success: false, error: "用户名或密码错误" },
        { status: 401 }
      );
    }

    // 验证密码（仅与数据库存储的哈希对比，不使用环境变量）
    const valid = await verifyPassword(password, admin.passwordHash);

    if (!valid) {
      recordLoginFailure(clientIp);

      // 记录失败审计日志（含 IP）
      await prisma.auditLog.create({
        data: {
          adminId: admin.id,
          action: "login_failed",
          detail: JSON.stringify({ username: admin.username }),
          ip: clientIp,
        },
      });

      return NextResponse.json(
        { success: false, error: "用户名或密码错误" },
        { status: 401 }
      );
    }

    // 登录成功，重置该 IP 的失败计数
    clearLoginFailures(clientIp);

    // 生成 Token
    const token = generateToken({
      adminId: admin.id,
      username: admin.username,
    });

    // 设置 Cookie
    await setAuthCookie(token);

    // 记录审计日志
    await prisma.auditLog.create({
      data: {
        adminId: admin.id,
        action: "login",
        detail: JSON.stringify({ username: admin.username }),
        ip: clientIp,
      },
    });

    return NextResponse.json({
      success: true,
      data: { token, username: admin.username },
      message: "登录成功",
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: "登录失败",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/admin/auth — 管理员登出
 */
export async function DELETE(request: NextRequest) {
  try {
    const admin = await getAdminFromRequest();
    const clientIp = getClientIp(request);

    await clearAuthCookie();

    if (admin) {
      await prisma.auditLog.create({
        data: {
          adminId: admin.adminId,
          action: "logout",
          detail: JSON.stringify({ username: admin.username }),
          ip: clientIp,
        },
      });
    }

    return NextResponse.json({
      success: true,
      message: "已退出登录",
    });
  } catch {
    await clearAuthCookie();
    return NextResponse.json({ success: true, message: "已退出登录" });
  }
}

/**
 * GET /api/admin/auth — 获取当前管理员信息
 */
export async function GET() {
  try {
    const admin = await getAdminFromRequest();
    if (!admin) {
      return NextResponse.json(
        { success: false, error: "未授权" },
        { status: 401 }
      );
    }

    return NextResponse.json({
      success: true,
      data: { adminId: admin.adminId, username: admin.username },
    });
  } catch {
    return NextResponse.json(
      { success: false, error: "未授权" },
      { status: 401 }
    );
  }
}
