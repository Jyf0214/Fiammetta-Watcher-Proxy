import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  generateToken,
  setAuthCookie,
  clearAuthCookie,
  hashPassword,
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
const LOGIN_CLEANUP_INTERVAL = 60_000; // 清理间隔

function cleanupLoginAttempts() {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts.entries()) {
    if (now - entry.windowStart >= LOGIN_WINDOW_MS) {
      loginAttempts.delete(ip);
    }
  }
}

// 定期清理防止内存泄漏
const globalForLoginCleanup = globalThis as unknown as { __loginCleanupTimer?: ReturnType<typeof setInterval> };
if (!globalForLoginCleanup.__loginCleanupTimer) {
  globalForLoginCleanup.__loginCleanupTimer = setInterval(cleanupLoginAttempts, LOGIN_CLEANUP_INTERVAL);
}

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

    const admin = await prisma.admin.findUnique({
      where: { username },
    });

    if (!admin) {
      await hashPassword("dummy");
      recordLoginFailure(clientIp);
      return NextResponse.json(
        { success: false, error: "用户名或密码错误" },
        { status: 401 }
      );
    }

    const valid = await verifyPassword(password, admin.passwordHash);

    if (!valid) {
      recordLoginFailure(clientIp);
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

    // 密码验证通过后，处理密码重置标志
    const resetFlag = await prisma.config.findUnique({
      where: { key: "admin_reset_password" },
    });

    if (resetFlag && resetFlag.value === "pending") {
      const envUsername = process.env.ADMIN_USERNAME;
      const envPassword = process.env.ADMIN_PASSWORD;
      if (envPassword && envUsername && admin.username === envUsername) {
        try {
          const newHash = await hashPassword(envPassword);
          await prisma.admin.update({
            where: { id: admin.id },
            data: { passwordHash: newHash },
          });
          await prisma.config.delete({
            where: { key: "admin_reset_password" },
          });
          console.log("[auth] 密码重置标志已处理，密码已更新");
        } catch (e) {
          console.error("[auth] 密码重置处理失败:", e);
        }
      } else {
        console.warn("[auth] 密码重置标志存在但环境变量不匹配或未配置，跳过重置");
        await prisma.config.delete({
          where: { key: "admin_reset_password" },
        });
      }
    }

    clearLoginFailures(clientIp);

    const token = generateToken({
      adminId: admin.id,
      username: admin.username,
    });

    await setAuthCookie(token);

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
      data: { username: admin.username },
      message: "登录成功",
    });
  } catch (error) {
    console.error("[auth] 登录异常:", error instanceof Error ? error.message : String(error));
    return NextResponse.json(
      {
        success: false,
        error: "登录失败",
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
  } catch (err) {
    console.error("[DELETE /api/admin/auth] 登出异常:", err);
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
  } catch (err) {
    console.error("[GET /api/admin/auth] 获取管理员信息失败:", err);
    return NextResponse.json(
      { success: false, error: "未授权" },
      { status: 401 }
    );
  }
}
