import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/auth";

/**
 * GET /api/admin/logs — 获取请求日志列表
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
  const status = searchParams.get("status");
  const isError = searchParams.get("isError");
  const type = searchParams.get("type");

  try {
    // 系统事件类型查询
    if (type === "events") {
      const where = {};
      const [items, total] = await Promise.all([
        prisma.systemEvent.findMany({
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.systemEvent.count({ where }),
      ]);

      return NextResponse.json({
        success: true,
        data: {
          items: items.map((e) => ({
            id: e.id,
            level: e.level,
            message: e.message,
            detail: e.detail,
            createdAt: e.createdAt.toISOString(),
          })),
          total,
          page,
          pageSize,
          totalPages: Math.ceil(total / pageSize),
        },
      });
    }

    // 请求日志查询
    const where: Record<string, unknown> = {};
    if (status) where.status = parseInt(status);
    if (isError !== null && isError !== undefined) {
      where.isError = isError === "true";
    }

    const [items, total] = await Promise.all([
      prisma.requestLog.findMany({
        where,
        include: {
          key: { select: { name: true } },
          platform: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.requestLog.count({ where }),
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
    console.error("[GET /api/admin/logs] 获取日志失败:", err);
    return NextResponse.json(
      {
        success: false,
        error: "获取日志失败",
      },
      { status: 500 }
    );
  }
}
