import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/auth";

/**
 * GET /api/admin/audit — 获取审计日志列表
 */
export async function GET(request: NextRequest) {
  const admin = await getAdminFromRequest();
  if (!admin) {
    return NextResponse.json(
      { success: false, error: "未授权" },
      { status: 401 }
    );
  }

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, parseInt(searchParams.get("pageSize") || "20", 10) || 20)
  );

  try {
    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({
        include: { admin: { select: { username: true } } },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.auditLog.count(),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        items: items.map((log) => ({
          ...log,
          createdAt: log.createdAt.toISOString(),
        })),
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (err) {
    console.error("[GET /api/admin/audit] 获取审计日志失败:", err);
    return NextResponse.json(
      {
        success: false,
        error: "获取审计日志失败",
      },
      { status: 500 }
    );
  }
}
