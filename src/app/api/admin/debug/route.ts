import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/admin/debug — 诊断管理员初始化状态（仅限调试）
 */
export async function GET() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  const databaseUrl = process.env.DATABASE_URL;

  const adminCount = await prisma.admin.count();
  const admins = await prisma.admin.findMany({
    select: { id: true, username: true, createdAt: true },
  });

  return NextResponse.json({
    env: {
      ADMIN_USERNAME: username ? `已设置 (${username})` : "未设置",
      ADMIN_PASSWORD: password ? "已设置" : "未设置",
      DATABASE_URL: databaseUrl ? `已设置 (${databaseUrl.substring(0, 30)}...)` : "未设置",
    },
    adminCount,
    admins,
  });
}
