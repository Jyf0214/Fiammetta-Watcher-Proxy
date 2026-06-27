import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/auth";

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
      ADMIN_USERNAME: process.env.ADMIN_USERNAME ? "已设置" : "未设置",
      ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ? "已设置" : "未设置",
      DATABASE_URL: databaseUrl ? "已设置" : "未设置",
      JWT_KEY: jwtKey ? "已设置" : "未设置",
    },
    adminCount,
  });
}
