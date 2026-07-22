/**
 * GET /api/admin/usage/platform — 获取平台维度用量统计
 *
 * 查询参数：
 * - period: 时间范围（today/week/month/all），默认 all
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/db";
import { requestLogs, platforms } from "@/lib/schema";
import { eq, and, gte, desc, sql, count, sum } from "drizzle-orm";
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
    if (!db) {
      res.status(500).json({ success: false, error: "数据库未配置" });
      return;
    }
    const orm = await createDb();

    const period = (req.query.period as string) || "all";

    // 计算时间过滤阈值（Unix 时间戳，秒）
    const now = Math.floor(Date.now() / 1000);
    let startTimestamp: number | undefined;
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
      default:
        startTimestamp = undefined;
    }

    // 构建时间过滤条件
    const timeCondition = startTimestamp !== undefined
      ? gte(requestLogs.createdAt, startTimestamp)
      : undefined;

    // 获取所有平台
    const allPlatforms = await orm
      .select({
        id: platforms.id,
        name: platforms.name,
        type: platforms.type,
        enabled: platforms.enabled,
        status: platforms.status,
        baseUrl: platforms.baseUrl,
        createdAt: platforms.createdAt,
      })
      .from(platforms)
      .orderBy(desc(platforms.createdAt));

    // 按 platformId 分组聚合统计
    const stats = await orm
      .select({
        platformId: requestLogs.platformId,
        totalRequests: count(),
        totalTokens: sum(requestLogs.tokens),
        promptTokens: sum(requestLogs.promptTokens),
        completionTokens: sum(requestLogs.completionTokens),
        avgTtft: sql<number>`round(coalesce(avg(${requestLogs.ttft}), 0))`,
        avgDuration: sql<number>`round(coalesce(avg(${requestLogs.latency}), 0))`,
        firstRequestAt: sql<number | null>`min(${requestLogs.createdAt})`,
        lastRequestAt: sql<number | null>`max(${requestLogs.createdAt})`,
      })
      .from(requestLogs)
      .where(timeCondition)
      .groupBy(requestLogs.platformId);

    // 按 platformId 分组获取错误请求数
    const errorStats = await orm
      .select({
        platformId: requestLogs.platformId,
        errorCount: count(),
      })
      .from(requestLogs)
      .where(timeCondition ? and(timeCondition, eq(requestLogs.isError, true)) : eq(requestLogs.isError, true))
      .groupBy(requestLogs.platformId);

    // 构建错误计数 Map
    const errorCountMap = new Map<string, number>();
    for (const e of errorStats) {
      const key = e.platformId || "unknown";
      errorCountMap.set(key, e.errorCount);
    }

    // 构建统计 Map
    const statsMap = new Map<string, (typeof stats)[number]>();
    for (const s of stats) {
      const statKey = s.platformId || "unknown";
      statsMap.set(statKey, s);
    }

    // 计算速率指标的辅助函数
    function computeRates(s: (typeof stats)[number]) {
      const totalTokens = Number(s.totalTokens || 0);
      const totalRequests = Number(s.totalRequests || 0);

      let timeSpanSeconds = 0;
      if (s.firstRequestAt != null && s.lastRequestAt != null) {
        const first = s.firstRequestAt as number;
        const last = s.lastRequestAt as number;
        timeSpanSeconds = Math.max(1, last - first);
      } else if (s.firstRequestAt != null) {
        timeSpanSeconds = Math.max(1, now - (s.firstRequestAt as number));
      }

      return {
        totalRequests,
        totalTokens,
        promptTokens: s.promptTokens || 0,
        completionTokens: s.completionTokens || 0,
        avgTtft: s.avgTtft || 0,
        avgDuration: s.avgDuration || 0,
        avgTokensPerSecond: timeSpanSeconds > 0
          ? Math.round((totalTokens / timeSpanSeconds) * 100) / 100
          : 0,
        avgRequestsPerMinute: timeSpanSeconds > 0
          ? Math.round(((totalRequests / timeSpanSeconds) * 60) * 100) / 100
          : 0,
        errorRequests: 0,
        firstRequestAt: s.firstRequestAt || null,
      };
    }

    // 合并平台信息和统计数据
    const result = allPlatforms.map((p) => {
      const pStats = statsMap.get(p.id);
      const rates = pStats ? computeRates(pStats) : {
        totalRequests: 0,
        totalTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        avgTtft: 0,
        avgDuration: 0,
        avgTokensPerSecond: 0,
        avgRequestsPerMinute: 0,
        errorRequests: 0,
        firstRequestAt: null,
      };
      rates.errorRequests = errorCountMap.get(p.id) || 0;

      return {
        id: p.id,
        name: p.name,
        type: p.type,
        enabled: p.enabled,
        status: p.status,
        baseUrl: p.baseUrl,
        createdAt: p.createdAt,
        stats: rates,
      };
    });

    // 添加 "未知平台" 条目（platformId 为 null 的请求）
    const unknownStats = statsMap.get("unknown");
    if (unknownStats && unknownStats.totalRequests > 0) {
      const rates = computeRates(unknownStats);
      rates.errorRequests = errorCountMap.get("unknown") || 0;
      result.push({
        id: "unknown",
        name: "未知平台",
        type: "unknown",
        enabled: false,
        status: "unknown",
        baseUrl: "",
        createdAt: now,
        stats: rates,
      });
    }

    res.status(200).json({
      success: true,
      data: result,
      total: result.length,
    });
  } catch (err) {
    console.error("[GET /api/admin/usage/platform] 获取平台用量失败:", err);
    res.status(500).json({ success: false, error: "获取平台用量失败" });
  }
}
