import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/auth";
import { forceRefreshProxyCache } from "@/lib/proxy-router";

/**
 * PUT /api/admin/pools/[id] — 更新代理池
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await getAdminFromRequest();
  if (!admin) {
    return NextResponse.json({ success: false, error: "未授权" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const body = await request.json();
    const existing = await prisma.proxyPool.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ success: false, error: "代理池不存在" }, { status: 404 });
    }

    const updateData: Record<string, unknown> = {};

    if (body.name !== undefined) {
      if (typeof body.name !== "string" || body.name.trim().length === 0) {
        return NextResponse.json({ success: false, error: "代理池名称不能为空" }, { status: 400 });
      }
      // 检查名称唯一性（排除自身）
      const duplicate = await prisma.proxyPool.findFirst({
        where: { name: body.name.trim(), id: { not: id } },
      });
      if (duplicate) {
        return NextResponse.json({ success: false, error: "代理池名称已存在" }, { status: 400 });
      }
      updateData.name = body.name.trim();
    }

    if (body.enabled !== undefined && typeof body.enabled === "boolean") {
      updateData.enabled = body.enabled;
    }

    const pool = await prisma.proxyPool.update({ where: { id }, data: updateData });

    await forceRefreshProxyCache();

    await prisma.auditLog.create({
      data: {
        adminId: admin.adminId,
        action: "update_proxy_pool",
        detail: JSON.stringify({ poolId: id, changes: updateData }),
        ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
      },
    });

    return NextResponse.json({ success: true, data: pool, message: "代理池更新成功" });
  } catch (err) {
    console.error("[PUT /api/admin/pools/[id]] 更新代理池失败:", err);
    return NextResponse.json({ success: false, error: "更新代理池失败" }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/pools/[id] — 删除代理池
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await getAdminFromRequest();
  if (!admin) {
    return NextResponse.json({ success: false, error: "未授权" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const existing = await prisma.proxyPool.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ success: false, error: "代理池不存在" }, { status: 404 });
    }

    // 将池内代理的 poolId 置空（不删除代理本身）
    await prisma.proxy.updateMany({
      where: { poolId: id },
      data: { poolId: null },
    });

    await prisma.proxyPool.delete({ where: { id } });
    await forceRefreshProxyCache();

    await prisma.auditLog.create({
      data: {
        adminId: admin.adminId,
        action: "delete_proxy_pool",
        detail: JSON.stringify({ poolId: id, name: existing.name }),
        ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
      },
    });

    return NextResponse.json({ success: true, message: "代理池删除成功" });
  } catch (err) {
    console.error("[DELETE /api/admin/pools/[id]] 删除代理池失败:", err);
    return NextResponse.json({ success: false, error: "删除代理池失败" }, { status: 500 });
  }
}
