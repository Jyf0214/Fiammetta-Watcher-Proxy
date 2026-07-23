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
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest } from "../_auth";

/** 趋势数据行类型 */
interface TrendRow {
  date: string;
  requests: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
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

  try {
    const orm = await createDb();

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
        const earliest = await orm.requestLogs.findMany({
          orderBy: { createdAt: "asc" },
          take: 1,
          select: { createdAt: true },
        });
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
    const conditions: string[] = ["created_at >= ?", "is_error = 0"];
    const params: unknown[] = [startTimestamp];

    if (keyId) {
      conditions.push("key_id = ?");
      params.push(keyId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // 使用原始 SQL 进行 SQLite strftime 聚合
    const trendSql = `
      SELECT
        strftime('${strftimeFormat}', datetime(created_at, 'unixepoch')) as date,
        COUNT(*) as requests,
        COALESCE(SUM(tokens), 0) as tokens,
        COALESCE(SUM(prompt_tokens), 0) as promptTokens,
        COALESCE(SUM(completion_tokens), 0) as completionTokens
      FROM request_logs
      ${whereClause}
      GROUP BY strftime('${strftimeFormat}', datetime(created_at, 'unixepoch'))
      ORDER BY date ASC
    `;

    const rows = await orm.$queryRawUnsafe<TrendRow[]>(trendSql, ...params);

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
    res.status(500).json({ success: false, error: "获取趋势数据失败", detail: err instanceof Error ? err.message : String(err) });
  }
}
