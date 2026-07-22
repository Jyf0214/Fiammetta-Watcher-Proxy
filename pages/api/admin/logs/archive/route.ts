/**
 * GET /api/admin/logs/archive — 查询已归档的日志统计数据（dailyStats 表）
 *
 * 查询参数：
 * - page: 页码，默认 1
 * - pageSize: 每页条数，默认 20，最大 100
 * - startDate: 起始日期（YYYY-MM-DD）
 * - endDate: 结束日期（YYYY-MM-DD，含当天全部）
 * - keyId: 按 API Key 筛选
 * - platformId: 按平台筛选
 * - model: 按模型筛选（模糊匹配）
 *
 * 参考 main 分支：src/app/api/admin/logs/archive/route.ts
 * 迁移变更：Prisma → Drizzle ORM (D1/SQLite)
 * 注意：dailyStats.date 为 Unix 时间戳（秒），需转换日期字符串进行比较
 */

import { NextRequest, NextResponse } from "next/server";
import { createDb } from "@/lib/db";
import { dailyStats } from "@/lib/schema";
import { eq, and, gte, lte, like, desc, sql, count } from "drizzle-orm";
import { verifyToken } from "@/lib/auth";

export const runtime = "edge";

/**
 * 从请求中提取管理员身份
 */
async function getAdminFromRequest(request: NextRequest): Promise<{ adminId: string; username: string } | null> {
  try {
    const token = request.cookies.get("admin_token")?.value;
    if (!token) return null;
    const payload = await verifyToken(token);
    if (!payload || !payload.adminId || !payload.username) return null;
    return { adminId: payload.adminId as string, username: payload.username as string };
  } catch {
    return null;
  }
}

/**
 * 将 YYYY-MM-DD 日期字符串转换为当天结束时的 Unix 时间戳（23:59:59）
 */
function dateToEndOfDay(dateStr: string): number {
  const d = new Date(dateStr + "T23:59:59Z");
  return Math.floor(d.getTime() / 1000);
}

/**
 * 将 YYYY-MM-DD 日期字符串转换为当天开始时的 Unix 时间戳（00:00:00）
 */
function dateToStartOfDay(dateStr: string): number {
  const d = new Date(dateStr + "T00:00:00Z");
  return Math.floor(d.getTime() / 1000);
}

export async function GET(request: NextRequest): Promise<Response> {
  const admin = await getAdminFromRequest(request);
  if (!admin) {
    return NextResponse.json({ success: false, error: "未授权" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get("pageSize") || "20", 10) || 20));
  const startDateStr = searchParams.get("startDate");
  const endDateStr = searchParams.get("endDate");
  const keyId = searchParams.get("keyId");
  const platformId = searchParams.get("platformId");
  const model = searchParams.get("model");

  try {
    const db = (globalThis as any).DB;
    if (!db) {
      return NextResponse.json({ success: false, error: "数据库未配置" }, { status: 500 });
    }
    const orm = createDb(db);

    // 构建查询条件
    const conditions = [];

    // 日期范围过滤（dailyStats.date 为 Unix 时间戳秒）
    if (startDateStr) {
      conditions.push(gte(dailyStats.date, dateToStartOfDay(startDateStr)));
    }
    if (endDateStr) {
      conditions.push(lte(dailyStats.date, dateToEndOfDay(endDateStr)));
    }

    // Key 筛选
    if (keyId) {
      conditions.push(eq(dailyStats.keyId, keyId));
    }

    // 平台筛选
    if (platformId) {
      conditions.push(eq(dailyStats.platformId, platformId));
    }

    // 模型筛选（模糊匹配）
    if (model) {
      conditions.push(like(dailyStats.model, `%${model}%`));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // 并行查询数据和总数
    const [items, totalResult] = await Promise.all([
      orm
        .select()
        .from(dailyStats)
        .where(whereClause)
        .orderBy(desc(dailyStats.date))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      orm
        .select({ total: count() })
        .from(dailyStats)
        .where(whereClause),
    ]);

    const total = totalResult[0]?.total || 0;

    return NextResponse.json({
      success: true,
      data: {
        items,
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
