import { NextResponse, NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/auth";
import { forceRefreshRouterCache } from "@/lib/router";

/**
 * GET /api/admin/models — 获取模型映射列表
 */
export async function GET() {
  const admin = await getAdminFromRequest();
  if (!admin) {
    return NextResponse.json(
      { success: false, error: "未授权" },
      { status: 401 }
    );
  }

  try {
    const models = await prisma.modelMap.findMany({
      include: { platform: true },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({ success: true, data: models });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: "获取模型映射失败", detail: String(error) },
      { status: 500 }
    );
  }
}

/**
 * POST /api/admin/models — 创建模型映射
 */
export async function POST(request: NextRequest) {
  const admin = await getAdminFromRequest();
  if (!admin) {
    return NextResponse.json(
      { success: false, error: "未授权" },
      { status: 401 }
    );
  }

  try {
    const body = await request.json();
    const { alias, targetModel, platformId } = body;

    if (!alias || !targetModel) {
      return NextResponse.json(
        { success: false, error: "模型别名和目标模型不能为空" },
        { status: 400 }
      );
    }

    const model = await prisma.modelMap.create({
      data: {
        alias,
        targetModel,
        platformId: platformId || null,
      },
    });

    await forceRefreshRouterCache();

    await prisma.auditLog.create({
      data: {
        adminId: admin.adminId,
        action: "create_model_map",
        detail: JSON.stringify({ modelId: model.id, alias, targetModel }),
        ip: request.headers.get("x-forwarded-for") || null,
      },
    });

    return NextResponse.json({
      success: true,
      data: model,
      message: "模型映射创建成功",
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: "创建模型映射失败", detail: String(error) },
      { status: 500 }
    );
  }
}
