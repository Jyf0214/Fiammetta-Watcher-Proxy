/**
 * GET /api/admin/usage — 获取 API Key 用量统计（Key 维度）
 *
 * 查询参数：
 * - keyId: 可选，指定单个 Key ID
 * - period: 可选，时间范围（today/week/month/all），默认 all
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest } from "./_auth";

/**
 * 掩码处理密钥值
 */
function maskKey(key: string): string {
  if (key.length > 12) {
    return key.substring(0, 8) + "..." + key.substring(key.length - 4);
  }
  return "***";
}

/** 聚合统计结果类型 */
interface AggRow {
  keyId: string | null;
  totalRequests: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  avgTtft: number;
  avgDuration: number;
  firstRequestAt: number | null;
  lastRequestAt: number | null;
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

    const keyId = req.query.keyId as string | undefined;
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

    // 获取所有 API Key（按创建时间倒序）
    const keys = await orm.apiKeys.findMany({
      orderBy: { createdAt: "desc" },
    });

    // 构建请求日志的查询条件（动态 SQL）
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (startTimestamp !== undefined) {
      conditions.push("created_at >= ?");
      params.push(startTimestamp);
    }
    if (keyId) {
      conditions.push("key_id = ?");
      params.push(keyId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // 按 keyId 分组聚合统计（使用原始 SQL）
    const statsSql = `
      SELECT
        key_id as keyId,
        COUNT(*) as totalRequests,
        COALESCE(SUM(tokens), 0) as totalTokens,
        COALESCE(SUM(prompt_tokens), 0) as promptTokens,
        COALESCE(SUM(completion_tokens), 0) as completionTokens,
        ROUND(COALESCE(AVG(ttft), 0)) as avgTtft,
        ROUND(COALESCE(AVG(latency), 0)) as avgDuration,
        MIN(created_at) as firstRequestAt,
        MAX(created_at) as lastRequestAt
      FROM request_logs
      ${whereClause}
      GROUP BY key_id
    `;

    const stats = await orm.$queryRawUnsafe<AggRow[]>(statsSql, ...params);

    // 构建统计 Map（keyId → stats）
    const statsMap = new Map<string, AggRow>();
    for (const s of stats) {
      if (s.keyId === null) continue;
      statsMap.set(s.keyId, s);
    }

    // 合并 Key 信息和统计数据
    const result = keys.map((k) => {
      const keyStats = statsMap.get(k.id);
      const totalTokens = Number(keyStats?.totalTokens || 0);
      const totalRequests = Number(keyStats?.totalRequests || 0);

      // 计算实际活动时间跨度
      let timeSpanSeconds = 0;
      if (keyStats?.firstRequestAt != null && keyStats?.lastRequestAt != null) {
        const first = keyStats.firstRequestAt as number;
        const last = keyStats.lastRequestAt as number;
        timeSpanSeconds = Math.max(1, last - first);
      } else if (keyStats?.firstRequestAt != null) {
        timeSpanSeconds = Math.max(1, now - (keyStats.firstRequestAt as number));
      }

      return {
        id: k.id,
        name: k.name,
        key: maskKey(k.key),
        status: k.status,
        tokenLimit: k.tokenLimit,
        usedTokens: k.usedTokens,
        createdAt: k.createdAt,
        stats: {
          totalRequests,
          totalTokens,
          promptTokens: keyStats?.promptTokens || 0,
          completionTokens: keyStats?.completionTokens || 0,
          avgTtft: keyStats?.avgTtft || 0,
          avgDuration: keyStats?.avgDuration || 0,
          avgTokensPerSecond: timeSpanSeconds > 0
            ? Math.round((totalTokens / timeSpanSeconds) * 100) / 100
            : 0,
          avgRequestsPerMinute: timeSpanSeconds > 0
            ? Math.round(((totalRequests / timeSpanSeconds) * 60) * 100) / 100
            : 0,
          firstRequestAt: keyStats?.firstRequestAt || null,
        },
      };
    });

    // 如果指定了 keyId，只返回该 Key 的数据
    if (keyId) {
      const filtered = result.filter((r) => r.id === keyId);
      res.status(200).json({
        success: true,
        data: filtered.length > 0 ? filtered[0] : null,
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: result,
      total: result.length,
    });
  } catch (err) {
    console.error("[GET /api/admin/usage] 获取用量统计失败:", err);
    res.status(500).json({ success: false, error: "获取用量统计失败", detail: err instanceof Error ? err.message : String(err) });
  }
}
