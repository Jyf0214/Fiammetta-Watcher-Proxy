import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/auth";

/**
 * GET /api/admin/logs/archive — 查询已归档的日志统计数据
 *
 * 查询参数：
 * - page: 页码，默认 1
 * - pageSize: 每页条数，默认 20，最大 100
 * - startDate: 起始日期（YYYY-MM-DD）
 * - endDate: 结束日期（YYYY-MM-DD，含当天全部）
 * - keyId: 按 API Key 筛选
 * - platformId: 按平台筛选
 * - model: 按模型筛选（模糊匹配）
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
  const startDateStr = searchParams.get("startDate");
  const endDateStr = searchParams.get("endDate");
  const keyId = searchParams.get("keyId");
  const platformId = searchParams.get("platformId");
  const model = searchParams.get("model");

  try {
    const where: Record<string, unknown> = {};

    // 日期范围
    if (startDateStr || endDateStr) {
      const dateFilter: Record<string, Date> = {};
      if (startDateStr) {
        dateFilter.gte = new Date(startDateStr);
      }
      if (endDateStr) {
        const end = new Date(endDateStr);
        end.setHours(23, 59, 59, 999);
        dateFilter.lte = end;
      }
      where.date = dateFilter;
    }

    // Key 筛选
    if (keyId) {
      where.keyId = keyId;
    }

    // 平台筛选
    if (platformId) {
      where.platformId = platformId;
    }

    // 模型筛选（模糊匹配）
    if (model) {
      where.model = { contains: model };
    }

    const [items, total] = await Promise.all([
      prisma.dailyStats.findMany({
        where,
        orderBy: { date: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.dailyStats.count({ where }),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        items: items.map((s) => ({
          ...s,
          date: s.date.toISOString(),
        })),
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (err) {
    console.error("[GET /api/admin/logs/archive] 查询归档日志失败:", err);
    return NextResponse.json(
      { success: false, error: "查询归档日志失败" },
      { status: 500 }
    );
  }
}
