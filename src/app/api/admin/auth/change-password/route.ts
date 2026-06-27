import { NextRequest, NextResponse } from "next/server";
import { getAdminFromRequest, hashPassword, verifyPassword } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// ---------- 密码修改速率限制（内存实现） ----------

interface ChangeAttemptEntry {
  count: number;
  windowStart: number;
}

/** 每个 IP 的密码修改失败尝试记录 */
const changeAttempts = new Map<string, ChangeAttemptEntry>();

const CHANGE_MAX_ATTEMPTS = 5;
const CHANGE_WINDOW_MS = 15 * 60 * 1000; // 15 分钟

/** 过期清理定时器，每 60 秒清理一次过期条目，防止内存泄漏 */
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of changeAttempts.entries()) {
    if (now - entry.windowStart >= CHANGE_WINDOW_MS) {
      changeAttempts.delete(ip);
    }
  }
}, 60_000);

/** 从请求中提取客户端 IP */
function getClientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

/** 检查该 IP 是否被限流，返回 null 表示允许，否则返回 429 响应 */
function checkChangeRateLimit(ip: string): NextResponse | null {
  const now = Date.now();
  const entry = changeAttempts.get(ip);

  // 窗口已过期，重置
  if (!entry || now - entry.windowStart >= CHANGE_WINDOW_MS) {
    changeAttempts.set(ip, { count: 0, windowStart: now });
    return null;
  }

  if (entry.count >= CHANGE_MAX_ATTEMPTS) {
    const resetAt = new Date(entry.windowStart + CHANGE_WINDOW_MS).toISOString();
    return NextResponse.json(
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

/**
 * POST /api/admin/auth/change-password — 管理员修改密码
 *
 * 要求：管理员已登录（携带有效 Cookie），验证旧密码后修改为新密码。
 * 速率限制：5 次 / 15 分钟 / IP，防止暴力尝试。
 */
export async function POST(request: NextRequest) {
  try {
    const clientIp = getClientIp(request);

    // 速率限制检查
    const rateLimitResponse = checkChangeRateLimit(clientIp);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    // 鉴权：验证管理员身份
    const admin = await getAdminFromRequest();
    if (!admin) {
      return NextResponse.json(
        { success: false, error: "未授权" },
        { status: 401 }
      );
    }

    // 解析请求体
    const body = await request.json();
    const { currentPassword, newPassword, confirmPassword } = body;

    // 校验：三个字段都不能为空
    if (!currentPassword || !newPassword || !confirmPassword) {
      return NextResponse.json(
        { success: false, error: "所有字段均为必填" },
        { status: 400 }
      );
    }

    // 校验：新密码长度至少 8 位，最多 128 位（DoS 防护）
    if (typeof newPassword !== "string" || newPassword.length < 8) {
      return NextResponse.json(
        { success: false, error: "新密码至少需要 8 个字符" },
        { status: 400 }
      );
    }
    if (newPassword.length > 128) {
      return NextResponse.json(
        { success: false, error: "新密码长度不能超过 128 个字符" },
        { status: 400 }
      );
    }

    // 校验：两次输入的新密码一致
    if (newPassword !== confirmPassword) {
      return NextResponse.json(
        { success: false, error: "两次输入的新密码不一致" },
        { status: 400 }
      );
    }

    // 查询管理员完整记录（获取密码哈希）
    const adminRecord = await prisma.admin.findUnique({
      where: { id: admin.adminId },
    });

    if (!adminRecord) {
      return NextResponse.json(
        { success: false, error: "管理员账户不存在" },
        { status: 401 }
      );
    }

    // 验证旧密码
    const isValid = await verifyPassword(currentPassword, adminRecord.passwordHash);
    if (!isValid) {
      recordChangeFailure(clientIp);

      // 记录失败审计日志
      await prisma.auditLog.create({
        data: {
          adminId: admin.adminId,
          action: "change_password_failed",
          detail: "当前密码错误",
          ip: clientIp,
        },
      });

      return NextResponse.json(
        { success: false, error: "当前密码错误" },
        { status: 400 }
      );
    }

    // 生成新密码哈希
    const newHash = await hashPassword(newPassword);

    // 更新数据库中的密码
    await prisma.admin.update({
      where: { id: admin.adminId },
      data: { passwordHash: newHash },
    });

    // 清除该 IP 的失败计数
    clearChangeFailures(clientIp);

    // 记录成功审计日志
    await prisma.auditLog.create({
      data: {
        adminId: admin.adminId,
        action: "change_password",
        detail: "密码已修改",
        ip: clientIp,
      },
    });

    return NextResponse.json({
      success: true,
      message: "密码修改成功",
    });
  } catch (error) {
    console.error("[auth] 修改密码异常:", error);
    return NextResponse.json(
      { success: false, error: "密码修改失败，请稍后重试" },
      { status: 500 }
    );
  }
}
