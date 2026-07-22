import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/auth";

/**
 * GET /api/admin/debug — 诊断管理员初始化状态（仅限调试）
 * 生产环境禁用，非生产环境对敏感信息进行脱敏处理
 */
export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }

  const admin = await getAdminFromRequest();
  if (!admin) {
    return NextResponse.json(
      { success: false, error: "未授权" },
      { status: 401 }
    );
  }

  const adminCount = await prisma.admin.count();

  // 仅暴露配置是否存在，不泄露任何实际值或元信息（如密码长度、URL片段、密钥类型）
  return NextResponse.json({
    env: {
      ADMIN_USERNAME: process.env.ADMIN_USERNAME ? "已设置" : "未设置",
      ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ? "已设置" : "未设置",
      DATABASE_URL: process.env.DATABASE_URL ? "已设置" : "未设置",
      JWT_KEY: (process.env.JWKS_KEY || process.env.JWT_SECRET) ? "已设置" : "未设置",
    },
    adminCount,
  });
}
