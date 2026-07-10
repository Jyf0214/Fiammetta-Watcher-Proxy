import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/auth";

async function requireAdmin() {
  const admin = await getAdminFromRequest();
  if (!admin) return null;
  return admin;
}

/**
 * GET /api/admin/pools — 获取代理池列表
 */
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json({ success: false, error: "未授权" }, { status: 401 });
  }

  try {
    const pools = await prisma.proxyPool.findMany({
      include: {
        _count: { select: { proxies: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    const data = pools.map((p) => ({
      id: p.id,
      name: p.name,
      enabled: p.enabled,
      proxyCount: p._count.proxies,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }));

    return NextResponse.json({ success: true, data, total: data.length });
  } catch (err) {
    console.error("[GET /api/admin/pools] 获取代理池列表失败:", err);
    return NextResponse.json({ success: false, error: "获取代理池列表失败" }, { status: 500 });
  }
}

/**
 * POST /api/admin/pools — 创建代理池
 */
export async function POST(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json({ success: false, error: "未授权" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { name } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json({ success: false, error: "代理池名称不能为空" }, { status: 400 });
    }

    // 检查名称唯一性
    const existing = await prisma.proxyPool.findUnique({ where: { name: name.trim() } });
    if (existing) {
      return NextResponse.json({ success: false, error: "代理池名称已存在" }, { status: 400 });
    }

    const pool = await prisma.proxyPool.create({
      data: { name: name.trim() },
    });

    await prisma.auditLog.create({
      data: {
        adminId: admin.adminId,
        action: "create_proxy_pool",
        detail: JSON.stringify({ poolId: pool.id, name: pool.name }),
        ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
      },
    });

    return NextResponse.json({ success: true, data: pool, message: "代理池创建成功" });
  } catch (err) {
    console.error("[POST /api/admin/pools] 创建代理池失败:", err);
    return NextResponse.json({ success: false, error: "创建代理池失败" }, { status: 500 });
  }
}
