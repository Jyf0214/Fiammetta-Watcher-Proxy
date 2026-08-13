/**
 * 归档日志统计 API
 *
 * GET    /api/admin/logs/archive — 查询已归档的日志统计数据（dailyStats 表）
 * POST   /api/admin/logs/archive — 手动触发日志归档（聚合过期日志到 dailyStats）
 *
 * 查询参数（GET）：
 * - page: 页码，默认 1
 * - pageSize: 每页条数，默认 20，最大 100
 * - startDate: 起始日期（YYYY-MM-DD）
 * - endDate: 结束日期（YYYY-MM-DD，含当天全部）
 * - keyId: 按 API Key 筛选
 * - platformId: 按平台筛选
 * - model: 按模型筛选（模糊匹配）
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb, type Prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/admin-auth";
import { checkCsrfOrigin } from "@/lib/admin-security";
import { checkAdminRateLimit } from "@/lib/admin-rate-limit";
import { runArchiveTask } from "../../../../worker/src/log-archiver";

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

  switch (req.method) {
    case "GET": return handleGet(req, res);
    case "POST": {
      // 变更操作遵循项目惯例：CSRF 来源校验 + 管理端速率限制
      if (!checkCsrfOrigin(req, res)) return;
      if (!await checkAdminRateLimit(admin.adminId, res)) return;
      return handlePost(req, res);
    }
    default:
      res.setHeader("Allow", ["GET", "POST"]);
      return res.status(405).json({ success: false, error: "Method not allowed" });
  }
}

/**
 * 校验 YYYY-MM-DD 日期字符串：格式正确 + 真实日历日期（排除 2024-13-99 等）
 * + 秒级时间戳在 Int32 范围内（超出会触发 Prisma Int 校验失败 → 500）
 */
function isValidDateStr(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  if (isNaN(d.getTime())) return false;
  const sec = Math.floor(d.getTime() / 1000);
  return sec >= 0 && sec <= 2147483647;
}

// ==================== GET — 查询归档统计 ====================

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const page = Math.max(1, parseInt((req.query.page as string) || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt((req.query.pageSize as string) || "20", 10) || 20));
  const startDateStr = req.query.startDate as string | undefined;
  const endDateStr = req.query.endDate as string | undefined;
  const keyId = req.query.keyId as string | undefined;
  const platformId = req.query.platformId as string | undefined;
  const model = req.query.model as string | undefined;

  if ((startDateStr && !isValidDateStr(startDateStr)) || (endDateStr && !isValidDateStr(endDateStr))) {
    return res.status(400).json({ success: false, error: "日期格式应为 YYYY-MM-DD" });
  }

  try {
    const orm = await createDb();

    // 构建查询条件
    const conditions: Prisma.dailyStatsWhereInput[] = [];

    // 日期范围过滤（dailyStats.date 为 Unix 时间戳秒）
    if (startDateStr) {
      conditions.push({ date: { gte: dateToStartOfDay(startDateStr) } });
    }
    if (endDateStr) {
      conditions.push({ date: { lte: dateToEndOfDay(endDateStr) } });
    }

    // Key 筛选
    if (keyId) {
      conditions.push({ keyId });
    }

    // 平台筛选
    if (platformId) {
      conditions.push({ platformId });
    }

    // 模型筛选（模糊匹配）
    // Prisma 的 contains 在 PostgreSQL/MySQL/TiDB 下直接拼接 LIKE '%...%'，不转义 %/_ 通配符；
    // 不转义时 model=% 会匹配全部记录（查询范围被放大），这里先行转义
    if (model) {
      const escaped = model.replace(/[\\%_]/g, (m) => `\\${m}`);
      conditions.push({ model: { contains: escaped } });
    }

    const where = conditions.length > 0 ? { AND: conditions } : undefined;

    // 并行查询数据和总数
    const [items, total] = await Promise.all([
      orm.dailyStats.findMany({
        where,
        orderBy: { date: "desc" },
        take: pageSize,
        skip: (page - 1) * pageSize,
      }),
      orm.dailyStats.count({ where }),
    ]);

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

// ==================== POST — 手动触发归档 ====================

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  try {
    // 注意：此模式仅在非 D1 数据库类型（TiDB/PostgreSQL/MySQL，生产 EdgeOne 为 TiDB）下有效——
    // createDb 忽略传入的 dummy DB，走 DB_TYPE + TIDB_URL/PG_URL 环境变量；
    // D1 部署下应改传真实 binding（无参调用自动检测）。与 pages/api/cron/[[...cron]].ts 用法一致。
    const result = await runArchiveTask({} as D1Database, { DB_TYPE: process.env.DB_TYPE });
    res.status(200).json(result);
  } catch (err) {
    console.error("[POST /api/admin/logs/archive] 手动归档失败:", err);
    res.status(500).json({ success: false, error: "归档失败" });
  }
}
