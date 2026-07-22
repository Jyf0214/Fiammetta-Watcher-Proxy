import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/auth";

/**
 * GET /api/admin/stats — 获取仪表盘统计数据
 */
export async function GET() {
  const admin = await getAdminFromRequest();
  if (!admin) {
    return NextResponse.json(
      { success: false, error: "未授权" },
      { status: 401 }
    );
  }

  try {
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
      prisma.platform.count(),
      prisma.platform.count({ where: { enabled: true } }),
      prisma.apiKey.count(),
      prisma.apiKey.count({ where: { status: "active" } }),
      prisma.requestLog.aggregate({
        _sum: { tokens: true },
        _count: true,
      }),
      prisma.requestLog.count({ where: { isError: true } }),
      prisma.requestLog.aggregate({
        _avg: { ttft: true, duration: true },
        where: { isError: false, ttft: { gt: 0 } },
      }),
      prisma.systemEvent.findMany({
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
    ]);

    // 计算全局平均 TTFT 和平均耗时
    const avgTtft = Math.round(perfStats._avg.ttft || 0);
    const avgDuration = Math.round(perfStats._avg.duration || 0);

    return NextResponse.json({
      success: true,
      data: {
        adminUsername: admin.username,
        dbConnected: true,
        totalPlatforms,
        activePlatforms,
        totalKeys,
        activeKeys,
        totalRequests: requestAgg._count,
        errorRequests: errorCount,
        totalTokens: requestAgg._sum.tokens || 0,
        avgTtft,
        avgDuration,
        recentEvents: recentEvents.map((e) => ({
          id: e.id,
          level: e.level,
          message: e.message,
          createdAt: e.createdAt.toISOString(),
        })),
      },
    });
  } catch (err) {
    console.error("[GET /api/admin/stats] 获取统计数据失败:", err);
    return NextResponse.json(
      {
        success: false,
        error: "获取统计数据失败",
      },
      { status: 500 }
    );
  }
}
