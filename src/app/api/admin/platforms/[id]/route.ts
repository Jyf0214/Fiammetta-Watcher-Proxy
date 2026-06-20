import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/auth";
import { forceRefreshRouterCache } from "@/lib/router";

/**
 * PUT /api/admin/platforms/[id] — 更新平台
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
    const body = await request.json();

    const platform = await prisma.platform.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.baseUrl !== undefined && { baseUrl: body.baseUrl }),
        ...(body.apiKey !== undefined && { apiKey: body.apiKey }),
        ...(body.type !== undefined && { type: body.type }),
        ...(body.enabled !== undefined && { enabled: body.enabled }),
        ...(body.priority !== undefined && { priority: body.priority }),
        ...(body.weight !== undefined && { weight: body.weight }),
        ...(body.rpmLimit !== undefined && { rpmLimit: body.rpmLimit ?? null }),
        ...(body.tpmLimit !== undefined && { tpmLimit: body.tpmLimit ?? null }),
      },
    });

    await forceRefreshRouterCache();

    await prisma.auditLog.create({
      data: {
        adminId: admin.adminId,
        action: "update_platform",
        detail: JSON.stringify({ platformId: id, changes: body }),
        ip: request.headers.get("x-forwarded-for") || null,
      },
    });

    return NextResponse.json({
      success: true,
      data: platform,
      message: "平台更新成功",
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: "更新平台失败",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/admin/platforms/[id] — 删除平台
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
    await prisma.platform.delete({ where: { id } });

    await forceRefreshRouterCache();

    await prisma.auditLog.create({
      data: {
        adminId: admin.adminId,
        action: "delete_platform",
        detail: JSON.stringify({ platformId: id }),
        ip: request.headers.get("x-forwarded-for") || null,
      },
    });

    return NextResponse.json({
      success: true,
      message: "平台删除成功",
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: "删除平台失败",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
