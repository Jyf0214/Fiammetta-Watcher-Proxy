/**
 * GET /api/admin/usage/trend — 获取请求量和 Token 使用趋势
 *
 * 查询参数：
 * - period: 时间范围（today/week/month/all），默认 month
 * - keyId: 可选，指定单个 Key ID
 *
 * 聚合粒度：
 * - today: 按小时聚合（显示 24 小时趋势）
 * - week/month/all: 按天聚合
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/db";
import { requestLogs } from "@/lib/schema";
import { and, eq, gte, sql } from "drizzle-orm";
import { getAdminFromRequest } from "../_auth";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    res.status(401).json({ success: false, error: "未授权" });
    return;
  }

  try {
    const db = (process.env as unknown as { DB: D1Database }).DB;
    if (!db) {
      res.status(500).json({ success: false, error: "数据库未配置" });
      return;
    }
    const orm = createDb(db);

    const period = (req.query.period as string) || "month";
    const keyId = req.query.keyId as string | undefined;

    // 计算时间范围（Unix 时间戳，秒）
    const now = Math.floor(Date.now() / 1000);
    let startTimestamp: number;
    switch (period) {
      case "today": {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        startTimestamp = Math.floor(d.getTime() / 1000);
        break;
      }
      case "week":
        startTimestamp = now - 7 * 24 * 60 * 60;
        break;
      case "month":
        startTimestamp = now - 30 * 24 * 60 * 60;
        break;
      default: {
        // all：取最早请求时间
        const earliest = await orm
          .select({ createdAt: requestLogs.createdAt })
          .from(requestLogs)
          .orderBy(requestLogs.createdAt)
          .limit(1);
        startTimestamp = earliest[0]?.createdAt || (now - 30 * 24 * 60 * 60);
      }
    }

    // 根据 period 决定聚合粒度：today 按小时，其他按天
    const isHourly = period === "today";

    // SQLite strftime 格式化：
    // createdAt 是 Unix 时间戳（秒），用 datetime(createdAt, 'unixepoch') 转为日期时间
    // 按小时：'%Y-%m-%d %H:00'
    // 按天：'%Y-%m-%d'
    const strftimeFormat = isHourly ? "%Y-%m-%d %H:00" : "%Y-%m-%d";

    // 构建查询条件
    const conditions = [
      gte(requestLogs.createdAt, startTimestamp),
      eq(requestLogs.isError, false),
    ];
    if (keyId) {
      conditions.push(eq(requestLogs.keyId, keyId));
    }
    const whereClause = and(...conditions);

    // 使用 Drizzle sql 模板进行 SQLite strftime 聚合
    const rows = await orm
      .select({
        date: sql<string>`strftime(${strftimeFormat}, datetime(${requestLogs.createdAt}, 'unixepoch'))`,
        requests: sql<number>`count(*)`,
        tokens: sql<number>`coalesce(sum(${requestLogs.tokens}), 0)`,
        promptTokens: sql<number>`coalesce(sum(${requestLogs.promptTokens}), 0)`,
        completionTokens: sql<number>`coalesce(sum(${requestLogs.completionTokens}), 0)`,
      })
      .from(requestLogs)
      .where(whereClause)
      .groupBy(sql`strftime(${strftimeFormat}, datetime(${requestLogs.createdAt}, 'unixepoch'))`)
      .orderBy(sql`date ASC`);

    const trend = rows.map((row) => ({
      date: String(row.date),
      requests: Number(row.requests),
      tokens: Number(row.tokens),
      promptTokens: Number(row.promptTokens),
      completionTokens: Number(row.completionTokens),
    }));

    res.status(200).json({ success: true, data: trend });
  } catch (err) {
    console.error("[GET /api/admin/usage/trend] 获取趋势数据失败:", err);
    res.status(500).json({ success: false, error: "获取趋势数据失败" });
  }
}
