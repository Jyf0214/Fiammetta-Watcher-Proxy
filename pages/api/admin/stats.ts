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
import { getAdminFromRequest } from "./_auth";

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
    const db = await createDb();

    // 并行查询所有统计数据
    const [
      totalPlatforms,
      activePlatforms,
      totalKeys,
      activeKeys,
      requestAgg,
      errorCount,
      perfRows,
      recentEvents,
    ] = await Promise.all([
      // 平台总数
      db.platforms.count(),
      // 启用的平台数
      db.platforms.count({ where: { enabled: true } }),
      // API Key 总数
      db.apiKeys.count(),
      // 活跃 API Key 数
      db.apiKeys.count({ where: { status: "active" } }),
      // 请求总数 + 总 token
      Promise.all([
        db.requestLogs.count(),
        db.requestLogs.aggregate({ _sum: { tokens: true } }),
      ]),
      // 错误请求数
      db.requestLogs.count({ where: { isError: true } }),
      // 性能统计：非错误请求的 ttft 和 latency，JS 侧计算平均值
      db.requestLogs.findMany({
        where: { isError: false },
        select: { ttft: true, latency: true },
      }),
      // 最近 10 条系统事件
      db.systemEvents.findMany({
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
    ]);

    const totalRequests = requestAgg[0];
    const sumTokens = requestAgg[1]._sum.tokens ?? 0;

    // JS 侧计算平均 TTFT 和平均耗时（仅统计 ttft > 0 / latency > 0 的记录）
    const validTtftRows = perfRows.filter((r) => r.ttft > 0);
    const validLatencyRows = perfRows.filter((r) => r.latency > 0);
    const avgTtft =
      validTtftRows.length > 0
        ? Math.round(validTtftRows.reduce((s, r) => s + r.ttft, 0) / validTtftRows.length)
        : 0;
    const avgDuration =
      validLatencyRows.length > 0
        ? Math.round(validLatencyRows.reduce((s, r) => s + r.latency, 0) / validLatencyRows.length)
        : 0;

    // 查询管理员信息（能查到说明 D1 已连接）
    const admin = await db.admins.findMany({ take: 1, select: { username: true } });

    res.status(200).json({
      success: true,
      data: {
        dbConnected: true,
        adminUsername: admin[0]?.username || "",
        totalPlatforms,
        activePlatforms,
        totalKeys,
        activeKeys,
        totalRequests,
        errorRequests: errorCount,
        totalTokens: sumTokens,
        avgTtft,
        avgDuration,
        recentEvents: recentEvents.map((e) => ({
          id: e.id,
          level: e.level,
          message: e.message,
          createdAt: new Date(e.createdAt * 1000).toISOString(),
        })),
      },
    });
  } catch (err) {
    console.error("[GET /api/admin/stats] 获取统计数据失败:", err);
    res.status(500).json({ success: false, error: "获取统计数据失败", detail: err instanceof Error ? err.message : String(err) });
  }
}
