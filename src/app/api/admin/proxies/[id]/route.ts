import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/auth";
import { forceRefreshProxyCache } from "@/lib/proxy-router";

/**
 * PUT /api/admin/proxies/[id] — 更新代理
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
    const existing = await prisma.proxy.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ success: false, error: "代理不存在" }, { status: 404 });
    }

    const updateData: Record<string, unknown> = {};

    if (body.address !== undefined) {
      if (typeof body.address !== "string" || body.address.trim().length === 0) {
        return NextResponse.json({ success: false, error: "代理地址不能为空" }, { status: 400 });
      }
      try {
        const url = new URL(body.address);
        if (!["http:", "https:", "socks5:"].includes(url.protocol)) {
          return NextResponse.json({ success: false, error: "代理地址协议必须为 http、https 或 socks5" }, { status: 400 });
        }
      } catch {
        return NextResponse.json({ success: false, error: "代理地址格式无效" }, { status: 400 });
      }
      updateData.address = body.address.trim();
    }

    if (body.enabled !== undefined && typeof body.enabled === "boolean") {
      updateData.enabled = body.enabled;
    }

    if (body.status !== undefined && ["healthy", "degraded", "down"].includes(body.status)) {
      updateData.status = body.status;
      if (body.status === "healthy") {
        updateData.failCount = 0;
        updateData.cooldownEnd = null;
      }
    }

    if (body.poolId !== undefined) {
      if (body.poolId === null || body.poolId === "") {
        updateData.poolId = null;
      } else if (typeof body.poolId === "string") {
        const pool = await prisma.proxyPool.findUnique({ where: { id: body.poolId } });
        if (!pool) {
          return NextResponse.json({ success: false, error: "关联代理池不存在" }, { status: 400 });
        }
        updateData.poolId = body.poolId;
      }
    }

    const proxy = await prisma.proxy.update({ where: { id }, data: updateData });
    await forceRefreshProxyCache();

    await prisma.auditLog.create({
      data: {
        adminId: admin.adminId,
        action: "update_proxy",
        detail: JSON.stringify({ proxyId: id, changes: updateData }),
        ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
      },
    });

    return NextResponse.json({ success: true, data: proxy, message: "代理更新成功" });
  } catch (err) {
    console.error("[PUT /api/admin/proxies/[id]] 更新代理失败:", err);
    return NextResponse.json({ success: false, error: "更新代理失败" }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/proxies/[id] — 删除代理
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
    const existing = await prisma.proxy.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ success: false, error: "代理不存在" }, { status: 404 });
    }

    await prisma.proxy.delete({ where: { id } });
    await forceRefreshProxyCache();

    await prisma.auditLog.create({
      data: {
        adminId: admin.adminId,
        action: "delete_proxy",
        detail: JSON.stringify({ proxyId: id }),
        ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
      },
    });

    return NextResponse.json({ success: true, message: "代理删除成功" });
  } catch (err) {
    console.error("[DELETE /api/admin/proxies/[id]] 删除代理失败:", err);
    return NextResponse.json({ success: false, error: "删除代理失败" }, { status: 500 });
  }
}
