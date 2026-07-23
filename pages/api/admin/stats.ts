/**
 * GET /api/admin/stats — 获取仪表盘统计数据
 *
 * 返回：
 * - 平台数量（总数 + 启用数）
 * - API Key 数量（总数 + 活跃数）
 * - 请求总数、错误数、总 token
 * - 平均 TTFT 和平均耗时
 * - 最近 10 条系统事件
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";

/** 单行聚合结果类型 */
interface CountRow {
  count: number;
}

/** 请求聚合结果类型 */
interface RequestAggRow {
  count: number;
  sum_tokens: number;
}

/** 性能统计结果类型 */
interface PerfRow {
  avg_ttft: number | null;
  avg_duration: number | null;
}

/** 系统事件行类型 */
interface EventRow {
  id: string;
  level: string;
  message: string;
  created_at: number;
}

/** 管理员行类型 */
interface AdminRow {
  username: string;
}

export default async function handler(
  _req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    const db = await createDb();

    // 并行查询所有统计数据
    const [
      totalPlatforms,
      activePlatforms,
      totalKeys,
      activeKeys,
      requestAgg,
      errorCount,
      perfStats,
      recentEvents,
    ] = await Promise.all([
      // 平台总数
      db.$queryRaw<CountRow[]>`SELECT COUNT(*) as count FROM platforms`,
      // 启用的平台数
      db.$queryRaw<CountRow[]>`SELECT COUNT(*) as count FROM platforms WHERE enabled = 1`,
      // API Key 总数
      db.$queryRaw<CountRow[]>`SELECT COUNT(*) as count FROM api_keys`,
      // 活跃 API Key 数
      db.$queryRaw<CountRow[]>`SELECT COUNT(*) as count FROM api_keys WHERE status = 'active'`,
      // 请求聚合：总数 + 总 token
      db.$queryRaw<RequestAggRow[]>`SELECT
        COUNT(*) as count,
        COALESCE(SUM(tokens), 0) as sum_tokens
      FROM request_logs`,
      // 错误请求数（is_error = 1）
      db.$queryRaw<CountRow[]>`SELECT COUNT(*) as count FROM request_logs WHERE is_error = 1`,
      // 性能统计：仅非错误请求中 ttft > 0 的记录
      db.$queryRaw<PerfRow[]>`SELECT
        AVG(CASE WHEN ttft > 0 THEN ttft ELSE NULL END) as avg_ttft,
        AVG(CASE WHEN latency > 0 THEN latency ELSE NULL END) as avg_duration
      FROM request_logs
      WHERE is_error = 0`,
      // 最近 10 条系统事件
      db.$queryRaw<EventRow[]>`SELECT id, level, message, created_at
        FROM system_events
        ORDER BY created_at DESC
        LIMIT 10`,
    ]);

    // 提取查询结果（$queryRaw 返回数组，取第一个元素）
    const totalPlatformsCount = totalPlatforms[0]?.count ?? 0;
    const activePlatformsCount = activePlatforms[0]?.count ?? 0;
    const totalKeysCount = totalKeys[0]?.count ?? 0;
    const activeKeysCount = activeKeys[0]?.count ?? 0;
    const requestAggResult = requestAgg[0];
    const errorCountResult = errorCount[0];
    const perfStatsResult = perfStats[0];

    // 计算全局平均 TTFT 和平均耗时
    const avgTtft = Math.round(perfStatsResult?.avg_ttft || 0);
    const avgDuration = Math.round(perfStatsResult?.avg_duration || 0);

    // 查询管理员信息（能查到说明 D1 已连接）
    const adminResult = await db.$queryRaw<AdminRow[]>`SELECT username FROM admins LIMIT 1`;
    const admin = adminResult[0];

    res.status(200).json({
      success: true,
      data: {
        dbConnected: true,
        adminUsername: admin?.username || "",
        totalPlatforms: totalPlatformsCount,
        activePlatforms: activePlatformsCount,
        totalKeys: totalKeysCount,
        activeKeys: activeKeysCount,
        totalRequests: requestAggResult?.count ?? 0,
        errorRequests: errorCountResult?.count ?? 0,
        totalTokens: requestAggResult?.sum_tokens ?? 0,
        avgTtft,
        avgDuration,
        recentEvents: recentEvents.map((e) => ({
          id: e.id,
          level: e.level,
          message: e.message,
          createdAt: new Date(e.created_at * 1000).toISOString(),
        })),
      },
    });
  } catch (err) {
    console.error("[GET /api/admin/stats] 获取统计数据失败:", err);
    res.status(500).json({ success: false, error: "获取统计数据失败", detail: err instanceof Error ? err.message : String(err) });
  }
}
