import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/auth";

/**
 * GET /api/admin/config — 获取系统配置（仅 system:* 前缀）
 */
export async function GET() {
  const admin = await getAdminFromRequest();
  if (!admin) {
    return NextResponse.json({ success: false, error: "未授权" }, { status: 401 });
  }

  const configs = await prisma.config.findMany({
    where: { key: { startsWith: "system:" } },
  });

  const data: Record<string, string> = {};
  for (const c of configs) {
    data[c.key] = c.value;
  }

  return NextResponse.json({ success: true, data });
}

/**
 * PUT /api/admin/config — 更新系统配置
 * body: { key: string, value: string }
 */
export async function PUT(request: NextRequest) {
  const admin = await getAdminFromRequest();
  if (!admin) {
    return NextResponse.json({ success: false, error: "未授权" }, { status: 401 });
  }

  const body = await request.json();
  const { key, value } = body;

  if (!key || typeof key !== "string" || !key.startsWith("system:")) {
    return NextResponse.json(
      { success: false, error: "配置键必须以 system: 开头" },
      { status: 400 }
    );
  }

  if (value === undefined || value === null || typeof value !== "string") {
    return NextResponse.json(
      { success: false, error: "配置值不能为空" },
      { status: 400 }
    );
  }

  await prisma.config.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });

  return NextResponse.json({ success: true, message: "配置已更新" });
}
