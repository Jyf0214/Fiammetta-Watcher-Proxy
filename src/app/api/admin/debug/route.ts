import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/auth";
import { hashPassword, verifyPassword } from "@/lib/auth-helpers";

const isDebug = process.env.LOGIN_DEBUG === "true";

/**
 * GET /api/admin/debug — 诊断管理员初始化状态（仅限调试）
 * 生产环境禁用，非生产环境对敏感信息进行脱敏处理
 */
export async function GET() {
  // 生产环境直接返回 404，禁止暴露诊断信息
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }

  // 身份验证：仅管理员可访问
  const admin = await getAdminFromRequest();
  if (!admin) {
    return NextResponse.json(
      { success: false, error: "未授权" },
      { status: 401 }
    );
  }

  const databaseUrl = process.env.DATABASE_URL;
  const jwtKey = process.env.JWKS_KEY || process.env.JWT_SECRET;

  const adminCount = await prisma.admin.count();

  return NextResponse.json({
    env: {
      // 仅显示是否配置，不暴露具体值，防止信息泄露
      ADMIN_USERNAME: process.env.ADMIN_USERNAME ? "已设置" : "未设置",
      ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ? "已设置（长度: " + process.env.ADMIN_PASSWORD.length + "）" : "未设置",
      DATABASE_URL: databaseUrl ? "已设置（末尾: ..." + databaseUrl.slice(-8) + "）" : "未设置",
      JWT_KEY: jwtKey ? "已设置（类型: " + (jwtKey.startsWith("{") ? "JSON" : jwtKey.includes("BEGIN") ? "PEM" : "字符串") + "）" : "未设置",
      LOGIN_DEBUG: process.env.LOGIN_DEBUG === "true" ? "已启用" : "未启用",
    },
    adminCount,
  });
}

/**
 * POST /api/admin/debug — 密码调试工具（仅限非生产环境）
 *
 * 支持两种模式：
 * 1. compare: 对比两个密码的哈希值
 * 2. verify: 用指定密码验证数据库中的密码哈希
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }

  if (!isDebug) {
    return NextResponse.json(
      { success: false, error: "请先设置环境变量 LOGIN_DEBUG=true" },
      { status: 400 }
    );
  }

  try {
    const body = await request.json();
    const { action, password, password2, username } = body;

    if (action === "compare") {
      // 模式1：对比两个密码的哈希值
      if (!password || !password2) {
        return NextResponse.json(
          { success: false, error: "需要提供 password 和 password2" },
          { status: 400 }
        );
      }

      const hash1 = await hashPassword(password);
      const hash2 = await hashPassword(password2);

      // 验证 password1 的哈希能否验证 password2
      const verifyResult = await verifyPassword(password2, hash1);
      // 反向验证
      const verifyResultReverse = await verifyPassword(password, hash2);

      return NextResponse.json({
        success: true,
        data: {
          password1: {
            length: password.length,
            hash: hash1,
          },
          password2: {
            length: password2.length,
            hash: hash2,
          },
          verification: {
            "password2_vs_hash1": verifyResult,
            "password1_vs_hash2": verifyResultReverse,
          },
          conclusion: verifyResult ? "密码相同" : "密码不同",
        },
      });
    }

    if (action === "verify") {
      // 模式2：验证数据库中的密码哈希
      if (!password || !username) {
        return NextResponse.json(
          { success: false, error: "需要提供 username 和 password" },
          { status: 400 }
        );
      }

      const admin = await prisma.admin.findUnique({
        where: { username },
      });

      if (!admin) {
        return NextResponse.json(
          { success: false, error: "管理员不存在" },
          { status: 404 }
        );
      }

      const storedHash = admin.passwordHash;
      const isValid = await verifyPassword(password, storedHash);

      // 解析存储的哈希
      const [salt, hash] = storedHash.split(":");

      // 用当前密码重新哈希，对比结果
      const freshHash = await hashPassword(password);

      return NextResponse.json({
        success: true,
        data: {
          username,
          storedHash: {
            prefix: storedHash.substring(0, 40) + "...",
            length: storedHash.length,
            salt: salt,
            hashLength: hash?.length || 0,
          },
          inputPassword: {
            length: password.length,
          },
          verification: {
            isValid,
          },
          freshHash: {
            prefix: freshHash.substring(0, 40) + "...",
            length: freshHash.length,
          },
          diagnosis: isValid
            ? "✅ 密码验证通过，哈希算法正常"
            : "❌ 密码验证失败，可能原因：密码不匹配 / 哈希格式异常 / 算法不一致",
        },
      });
    }

    return NextResponse.json(
      { success: false, error: "未知的 action，支持: compare, verify" },
      { status: 400 }
    );
  } catch (e) {
    return NextResponse.json(
      {
        success: false,
        error: "调试请求处理失败",
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 500 }
    );
  }
}
