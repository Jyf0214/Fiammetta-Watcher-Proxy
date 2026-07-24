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

    // 使用 Prisma ORM 查询所有匹配记录，只 select 聚合所需字段
    const logs = await orm.requestLogs.findMany({
      where: {
        createdAt: { gte: startTimestamp },
        isError: false,
        ...(keyId ? { keyId } : {}),
      },
      select: {
        tokens: true,
        promptTokens: true,
        completionTokens: true,
        createdAt: true,
      },
    });

    // 在 JS 中按日期分组并聚合
    const groups = new Map<
      string,
      { requests: number; tokens: number; promptTokens: number; completionTokens: number }
    >();

    for (const log of logs) {
      // createdAt 是 Unix 秒时间戳，转为 JS Date
      const d = new Date(log.createdAt * 1000);

      // 按 strftime 格式生成日期键：today 用 'YYYY-MM-DD HH:00'，其他用 'YYYY-MM-DD'
      let dateKey: string;
      if (isHourly) {
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        const hour = String(d.getHours()).padStart(2, "0");
        dateKey = `${year}-${month}-${day} ${hour}:00`;
      } else {
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        dateKey = `${year}-${month}-${day}`;
      }

      const existing = groups.get(dateKey);
      if (existing) {
        existing.requests += 1;
        existing.tokens += log.tokens ?? 0;
        existing.promptTokens += log.promptTokens ?? 0;
        existing.completionTokens += log.completionTokens ?? 0;
      } else {
        groups.set(dateKey, {
          requests: 1,
          tokens: log.tokens ?? 0,
          promptTokens: log.promptTokens ?? 0,
          completionTokens: log.completionTokens ?? 0,
        });
      }
    }

    // 转为数组并按日期排序（与原 SQL ORDER BY date ASC 一致）
    const trend = Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, data]) => ({
        date,
        requests: data.requests,
        tokens: data.tokens,
        promptTokens: data.promptTokens,
        completionTokens: data.completionTokens,
      }));

    res.status(200).json({ success: true, data: trend });
  } catch (err) {
    console.error("[GET /api/admin/usage/trend] 获取趋势数据失败:", err);
    res.status(500).json({ success: false, error: "获取趋势数据失败", detail: err instanceof Error ? err.message : String(err) });
  }
}
