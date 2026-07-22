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
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/db";
import { dailyStats } from "@/lib/schema";
import { eq, and, gte, lte, like, desc, count } from "drizzle-orm";
import { getAdminFromRequest } from "../_auth";

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

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    res.status(401).json({ success: false, error: "未授权" });
    return;
  }

  const page = Math.max(1, parseInt((req.query.page as string) || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt((req.query.pageSize as string) || "20", 10) || 20));
  const startDateStr = req.query.startDate as string | undefined;
  const endDateStr = req.query.endDate as string | undefined;
  const keyId = req.query.keyId as string | undefined;
  const platformId = req.query.platformId as string | undefined;
  const model = req.query.model as string | undefined;

  try {
    if (!db) {
      res.status(500).json({ success: false, error: "数据库未配置" });
      return;
    }
    const orm = await createDb();

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

    res.status(200).json({
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
    res.status(500).json({ success: false, error: "查询归档日志失败" });
  }
}
