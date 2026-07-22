import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/auth";
import { forceRefreshRouterCache } from "@/lib/router";

/**
 * PUT /api/admin/models/[id] — 更新模型映射
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await getAdminFromRequest();
  if (!admin) {
    return NextResponse.json(
      { success: false, error: "未授权" },
      { status: 401 }
    );
  }

  const { id } = await params;

  try {
    // 检查模型映射是否存在
    const existing = await prisma.modelMap.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json(
        { success: false, error: "模型映射不存在" },
        { status: 404 }
      );
    }

    const body = await request.json();

    // 字符串长度校验
    const errors: string[] = [];
    if (body.alias !== undefined && typeof body.alias === "string" && body.alias.length > 100) {
      errors.push("模型别名不能超过 100 个字符");
    }
    if (body.targetModel !== undefined && typeof body.targetModel === "string" && body.targetModel.length > 200) {
      errors.push("目标模型名称不能超过 200 个字符");
    }
    if (errors.length > 0) {
      return NextResponse.json(
        { success: false, error: errors.join("; ") },
        { status: 400 }
      );
    }

    // platformId 存在性校验
    if (body.platformId !== undefined && body.platformId !== null) {
      const platformExists = await prisma.platform.findUnique({
        where: { id: body.platformId },
      });
      if (!platformExists) {
        return NextResponse.json(
          { success: false, error: "指定的 platformId 对应的平台不存在" },
          { status: 400 }
        );
      }
    }

    const updated = await prisma.modelMap.update({
      where: { id },
      data: {
        ...(body.alias !== undefined && { alias: body.alias }),
        ...(body.targetModel !== undefined && { targetModel: body.targetModel }),
        ...(body.platformId !== undefined && { platformId: body.platformId ?? null }),
      },
    });

    await forceRefreshRouterCache();

    // 脱敏处理 - 移除敏感字段
    const sanitized = { ...body };
    if (sanitized.apiKey) sanitized.apiKey = sanitized.apiKey.substring(0, 6) + "***";
    if (sanitized.key) sanitized.key = sanitized.key.substring(0, 8) + "***";

    await prisma.auditLog.create({
      data: {
        adminId: admin.adminId,
        action: "update_model_map",
        detail: JSON.stringify({ modelId: id, changes: sanitized }),
        ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
      },
    });

    return NextResponse.json({
      success: true,
      data: updated,
      message: "模型映射更新成功",
    });
  } catch (err) {
    console.error("[PUT /api/admin/models/[id]] 更新模型映射失败:", err);
    return NextResponse.json(
      {
        success: false,
        error: "更新模型映射失败",
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/admin/models/[id] — 删除模型映射
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await getAdminFromRequest();
  if (!admin) {
    return NextResponse.json(
      { success: false, error: "未授权" },
      { status: 401 }
    );
  }

  const { id } = await params;

  try {
    // 检查模型映射是否存在
    const existing = await prisma.modelMap.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json(
        { success: false, error: "模型映射不存在" },
        { status: 404 }
      );
    }

    await prisma.modelMap.delete({ where: { id } });

    await forceRefreshRouterCache();

    await prisma.auditLog.create({
      data: {
        adminId: admin.adminId,
        action: "delete_model_map",
        detail: JSON.stringify({ modelId: id, alias: existing.alias }),
        ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
      },
    });

    return NextResponse.json({
      success: true,
      message: "模型映射删除成功",
    });
  } catch (err) {
    console.error("[DELETE /api/admin/models/[id]] 删除模型映射失败:", err);
    return NextResponse.json(
      {
        success: false,
        error: "删除模型映射失败",
      },
      { status: 500 }
    );
  }
}
