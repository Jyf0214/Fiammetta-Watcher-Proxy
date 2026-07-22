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
      include: {
        platform: {
          select: {
            id: true,
            name: true,
            baseUrl: true,
            type: true,
            enabled: true,
            priority: true,
            weight: true,
            status: true,
            failCount: true,
            lastFailAt: true,
            cooldownEnd: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({ success: true, data: models });
  } catch (err) {
    console.error("[GET /api/admin/models] 获取模型映射失败:", err);
    return NextResponse.json(
      { success: false, error: "获取模型映射失败" },
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

    // 校验 platformId 是否存在（如果提供了的话）
    if (body.platformId) {
      const platform = await prisma.platform.findUnique({ where: { id: body.platformId } });
      if (!platform) {
        return NextResponse.json({ success: false, error: "指定的平台不存在" }, { status: 400 });
      }
    }

    const errors: string[] = [];
    if (typeof alias === "string" && alias.length > 100) {
      errors.push("模型别名不能超过 100 个字符");
    }
    if (typeof targetModel === "string" && targetModel.length > 200) {
      errors.push("目标模型名称不能超过 200 个字符");
    }
    if (errors.length > 0) {
      return NextResponse.json(
        { success: false, error: errors.join("; ") },
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
        ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
      },
    });

    return NextResponse.json({
      success: true,
      data: model,
      message: "模型映射创建成功",
    });
  } catch (err) {
    console.error("[POST /api/admin/models] 创建模型映射失败:", err);
    return NextResponse.json(
      { success: false, error: "创建模型映射失败" },
      { status: 500 }
    );
  }
}
