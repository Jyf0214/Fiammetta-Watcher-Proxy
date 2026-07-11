import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/auth";

/**
 * GET /api/admin/logs — 获取请求日志列表
 *
 * 查询参数：
 * - page: 页码，默认 1
 * - pageSize: 每页条数，默认 20，最大 100
 * - status: HTTP 状态码筛选
 * - isError: 是否错误（true/false）
 * - type: events — 查询系统事件
 * - keyId: 按 API Key 筛选
 * - startDate: 起始日期（ISO 格式或 YYYY-MM-DD）
 * - endDate: 结束日期（ISO 格式或 YYYY-MM-DD，含当天全部）
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
  const keyId = searchParams.get("keyId");
  const startDateStr = searchParams.get("startDate");
  const endDateStr = searchParams.get("endDate");

  try {
    // 系统事件类型查询
    if (type === "events") {
      const [items, total] = await Promise.all([
        prisma.systemEvent.findMany({
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.systemEvent.count(),
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

    // 请求日志查询 — 构建 where 条件（所有条件 AND 组合）
    const where: Record<string, unknown> = {};

    // 状态码筛选
    if (status) {
      const n = parseInt(status, 10);
      if (!isNaN(n)) where.status = n;
    }

    // 错误筛选
    if (isError !== null && isError !== undefined && isError !== "") {
      where.isError = isError === "true";
    }

    // API Key 筛选
    if (keyId) {
      where.keyId = keyId;
    }

    // 日期范围筛选
    if (startDateStr || endDateStr) {
      const createdAtFilter: Record<string, Date> = {};
      if (startDateStr) {
        createdAtFilter.gte = new Date(startDateStr);
      }
      if (endDateStr) {
        // 结束日期含当天全部：取当天 23:59:59.999
        const end = new Date(endDateStr);
        end.setHours(23, 59, 59, 999);
        createdAtFilter.lte = end;
      }
      where.createdAt = createdAtFilter;
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
      { success: false, error: "获取日志失败" },
      { status: 500 }
    );
  }
}
