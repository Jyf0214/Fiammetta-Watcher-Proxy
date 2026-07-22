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
import { createDb } from "@/lib/db";

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
      db.get<{ count: number }>(
        `SELECT COUNT(*) as count FROM platforms`
      ),
      // 启用的平台数
      db.get<{ count: number }>(
        `SELECT COUNT(*) as count FROM platforms WHERE enabled = 1`
      ),
      // API Key 总数
      db.get<{ count: number }>(
        `SELECT COUNT(*) as count FROM api_keys`
      ),
      // 活跃 API Key 数
      db.get<{ count: number }>(
        `SELECT COUNT(*) as count FROM api_keys WHERE status = 'active'`
      ),
      // 请求聚合：总数 + 总 token
      db.get<{ count: number; sum_tokens: number }>(
        `SELECT
           COUNT(*) as count,
           COALESCE(SUM(tokens), 0) as sum_tokens
         FROM request_logs`
      ),
      // 错误请求数（is_error = 1）
      db.get<{ count: number }>(
        `SELECT COUNT(*) as count FROM request_logs WHERE is_error = 1`
      ),
      // 性能统计：仅非错误请求中 ttft > 0 的记录
      db.get<{ avg_ttft: number | null; avg_duration: number | null }>(
        `SELECT
           AVG(CASE WHEN ttft > 0 THEN ttft ELSE NULL END) as avg_ttft,
           AVG(CASE WHEN latency > 0 THEN latency ELSE NULL END) as avg_duration
         FROM request_logs
         WHERE is_error = 0`
      ),
      // 最近 10 条系统事件
      db.all<{
        id: string;
        level: string;
        message: string;
        created_at: number;
      }>(
        `SELECT id, level, message, created_at
         FROM system_events
         ORDER BY created_at DESC
         LIMIT 10`
      ),
    ]);

    // 计算全局平均 TTFT 和平均耗时
    const avgTtft = Math.round(perfStats?.avg_ttft || 0);
    const avgDuration = Math.round(perfStats?.avg_duration || 0);

    res.status(200).json({
      success: true,
      data: {
        totalPlatforms: totalPlatforms?.count ?? 0,
        activePlatforms: activePlatforms?.count ?? 0,
        totalKeys: totalKeys?.count ?? 0,
        activeKeys: activeKeys?.count ?? 0,
        totalRequests: requestAgg?.count ?? 0,
        errorRequests: errorCount?.count ?? 0,
        totalTokens: requestAgg?.sum_tokens ?? 0,
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
    res.status(500).json({ success: false, error: "获取统计数据失败" });
  }
}
