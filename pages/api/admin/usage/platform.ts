/**
 * GET /api/admin/usage/platform — 获取平台维度用量统计
 *
 * 查询参数：
 * - period: 时间范围（today/week/month/all），默认 all
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest } from "../_auth";

/** 聚合统计结果类型 */
interface AggRow {
  platformId: string | null;
  totalRequests: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  avgTtft: number;
  avgDuration: number;
  firstRequestAt: number | null;
  lastRequestAt: number | null;
}

/** 错误统计结果类型 */
interface ErrorRow {
  platformId: string | null;
  errorCount: number;
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
    const timeConditions: string[] = [];
    const timeParams: unknown[] = [];
    if (startTimestamp !== undefined) {
      timeConditions.push("created_at >= ?");
      timeParams.push(startTimestamp);
    }

    // 获取所有平台
    const allPlatforms = await orm.platforms.findMany({
      orderBy: { createdAt: "desc" },
    });

    // 按 platformId 分组聚合统计
    const timeWhereClause = timeConditions.length > 0 ? `WHERE ${timeConditions.join(" AND ")}` : "";
    const statsSql = `
      SELECT
        platform_id as platformId,
        COUNT(*) as totalRequests,
        COALESCE(SUM(tokens), 0) as totalTokens,
        COALESCE(SUM(prompt_tokens), 0) as promptTokens,
        COALESCE(SUM(completion_tokens), 0) as completionTokens,
        ROUND(COALESCE(AVG(ttft), 0)) as avgTtft,
        ROUND(COALESCE(AVG(latency), 0)) as avgDuration,
        MIN(created_at) as firstRequestAt,
        MAX(created_at) as lastRequestAt
      FROM request_logs
      ${timeWhereClause}
      GROUP BY platform_id
    `;
    const stats = await orm.$queryRawUnsafe<AggRow[]>(statsSql, ...timeParams);

    // 按 platformId 分组获取错误请求数
    const errorWhereClause = timeConditions.length > 0
      ? `WHERE ${timeConditions.join(" AND ")} AND is_error = 1`
      : "WHERE is_error = 1";
    const errorStatsSql = `
      SELECT
        platform_id as platformId,
        COUNT(*) as errorCount
      FROM request_logs
      ${errorWhereClause}
      GROUP BY platform_id
    `;
    const errorStats = await orm.$queryRawUnsafe<ErrorRow[]>(errorStatsSql, ...timeParams);

    // 构建错误计数 Map
    const errorCountMap = new Map<string, number>();
    for (const e of errorStats) {
      const key = e.platformId || "unknown";
      errorCountMap.set(key, Number(e.errorCount));
    }

    // 构建统计 Map
    const statsMap = new Map<string, AggRow>();
    for (const s of stats) {
      const statKey = s.platformId || "unknown";
      statsMap.set(statKey, s);
    }

    // 计算速率指标的辅助函数
    function computeRates(s: AggRow) {
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
    if (unknownStats && Number(unknownStats.totalRequests) > 0) {
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
    res.status(500).json({ success: false, error: "获取平台用量失败", detail: err instanceof Error ? err.message : String(err) });
  }
}
