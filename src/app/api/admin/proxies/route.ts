import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/auth";
import { forceRefreshProxyCache } from "@/lib/proxy-router";
import { isDebug } from "@/lib/auth-helpers";

async function requireAdmin() {
  const admin = await getAdminFromRequest();
  if (!admin) return null;
  return admin;
}

/**
 * GET /api/admin/proxies — 获取代理列表
 */
export async function GET(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json({ success: false, error: "未授权" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const platformId = searchParams.get("platformId");

    const where = platformId ? { platformId } : {};

    const proxies = await prisma.proxy.findMany({
      where,
      include: { platform: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
    });

    const now = new Date();
    const data = proxies.map((p) => ({
      ...p,
      isBanned: p.status === "down" && !!p.cooldownEnd && p.cooldownEnd > now,
    }));

    return NextResponse.json({ success: true, data, total: data.length });
  } catch (err) {
    console.error("[GET /api/admin/proxies] 获取代理列表失败:", err);
    return NextResponse.json({ success: false, error: "获取代理列表失败" }, { status: 500 });
  }
}

/**
 * POST /api/admin/proxies — 创建代理
 */
export async function POST(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json({ success: false, error: "未授权" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { address, platformId } = body;

    const errors: string[] = [];

    if (!address || typeof address !== "string" || address.trim().length === 0) {
      errors.push("代理地址不能为空");
    } else {
      try {
        const url = new URL(address);
        if (!["http:", "https:", "socks5:"].includes(url.protocol)) {
          errors.push("代理地址协议必须为 http、https 或 socks5");
        }
      } catch {
        errors.push("代理地址格式无效");
      }
    }

    if (!platformId || typeof platformId !== "string") {
      errors.push("必须指定关联平台");
    } else {
      const platform = await prisma.platform.findUnique({ where: { id: platformId } });
      if (!platform) errors.push("关联平台不存在");
    }

    if (errors.length > 0) {
      return NextResponse.json({ success: false, error: errors.join("; ") }, { status: 400 });
    }

    const proxy = await prisma.proxy.create({
      data: { address: address.trim(), platformId },
    });

    await forceRefreshProxyCache();

    await prisma.auditLog.create({
      data: {
        adminId: admin.adminId,
        action: "create_proxy",
        detail: JSON.stringify({ proxyId: proxy.id, address: "***", platformId }),
        ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
      },
    });

    if (isDebug) console.log("[DEBUG] 创建代理:", { id: proxy.id, platformId });

    return NextResponse.json({ success: true, data: proxy, message: "代理创建成功" });
  } catch (err) {
    console.error("[POST /api/admin/proxies] 创建代理失败:", err);
    return NextResponse.json({ success: false, error: "创建代理失败" }, { status: 500 });
  }
}
