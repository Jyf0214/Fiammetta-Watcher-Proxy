import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/auth";

/**
 * 验证管理员身份的通用守卫
 */
async function requireAdmin() {
  const admin = await getAdminFromRequest();
  if (!admin) {
    return null;
  }
  return admin;
}

/**
 * GET /api/admin/platforms — 获取平台列表
 */
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json(
      { success: false, error: "未授权" },
      { status: 401 }
    );
  }

  try {
    const platforms = await prisma.platform.findMany({
      orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
    });

    return NextResponse.json({
      success: true,
      data: platforms,
      total: platforms.length,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: "获取平台列表失败",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

/**
 * POST /api/admin/platforms — 创建平台
 */
export async function POST(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json(
      { success: false, error: "未授权" },
      { status: 401 }
    );
  }

  try {
    const body = await request.json();
    const { name, baseUrl, apiKey, type, priority, weight, rpmLimit, tpmLimit } =
      body;

    if (!name || !baseUrl || !apiKey) {
      return NextResponse.json(
        { success: false, error: "平台名称、基础 URL 和 API Key 不能为空" },
        { status: 400 }
      );
    }

    const VALID_PLATFORM_TYPES = ["openai", "azure", "custom"] as const;
    const platformType = VALID_PLATFORM_TYPES.includes(type) ? type : "openai";

    const platform = await prisma.platform.create({
      data: {
        name,
        baseUrl,
        apiKey,
        type: platformType,
        priority: priority ?? 0,
        weight: weight ?? 1,
        rpmLimit: rpmLimit ?? null,
        tpmLimit: tpmLimit ?? null,
      },
    });

    // 审计日志
    await prisma.auditLog.create({
      data: {
        adminId: admin.adminId,
        action: "create_platform",
        detail: JSON.stringify({ platformId: platform.id, name }),
        ip: request.headers.get("x-forwarded-for") || null,
      },
    });

    return NextResponse.json({
      success: true,
      data: platform,
      message: "平台创建成功",
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: "创建平台失败",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
