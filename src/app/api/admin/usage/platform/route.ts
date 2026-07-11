import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/auth";
import { serializeBigInt } from "@/lib/serialize";

/**
 * GET /api/admin/usage/platform — 获取平台维度用量统计
 *
 * 查询参数：
 * - period: 时间范围（today/week/month/all），默认 all
 */
export async function GET(request: NextRequest) {
  const admin = await getAdminFromRequest();
  if (!admin) {
    return NextResponse.json(
      { success: false, error: "未授权" },
      { status: 401 }
    );
  }

  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "all";

    // 构建时间过滤条件
    let dateFilter: Date | undefined;
    const now = new Date();
    switch (period) {
      case "today":
        dateFilter = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case "week":
        dateFilter = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case "month":
        dateFilter = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      default:
        dateFilter = undefined;
    }

    const whereClause: Record<string, unknown> = {};
    if (dateFilter) {
      whereClause.createdAt = { gte: dateFilter };
    }

    // 获取所有平台
    const platforms = await prisma.platform.findMany({
      select: {
        id: true,
        name: true,
        type: true,
        enabled: true,
        status: true,
        baseUrl: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    // 获取每个平台的请求统计
    const stats = await prisma.requestLog.groupBy({
      by: ["platformId"],
      where: whereClause,
      _sum: {
        tokens: true,
        promptTokens: true,
        completionTokens: true,
      },
      _count: true,
      _avg: {
        ttft: true,
        duration: true,
      },
      _min: {
        createdAt: true,
      },
      _max: {
        createdAt: true,
      },
    });

    // 计算每个平台的统计指标
    const statsMap = new Map<
      string,
      {
        totalRequests: number;
        totalTokens: number;
        promptTokens: number;
        completionTokens: number;
        avgTtft: number;
        avgDuration: number;
        avgTokensPerSecond: number;
        avgRequestsPerMinute: number;
        errorRequests: number;
        firstRequestAt: string | null;
      }
    >();

    // 获取每个平台的错误请求数
    const errorStats = await prisma.requestLog.groupBy({
      by: ["platformId"],
      where: { ...whereClause, isError: true },
      _count: true,
    });
    const errorCountMap = new Map<string, number>();
    for (const e of errorStats) {
      if (e.platformId) errorCountMap.set(e.platformId, e._count);
    }

    for (const s of stats) {
      if (s.platformId === null) continue;

      const totalTokens = s._sum.tokens || 0;
      const promptTokens = s._sum.promptTokens || 0;
      const completionTokens = s._sum.completionTokens || 0;
      const totalRequests = s._count;
      const avgTtft = Math.round(s._avg.ttft || 0);
      const avgDuration = Math.round(s._avg.duration || 0);

      const firstRequestAt = s._min.createdAt;
      const lastRequestAt = s._max.createdAt;
      let timeSpanSeconds = 0;
      if (firstRequestAt && lastRequestAt) {
        timeSpanSeconds = Math.max(
          1,
          Math.floor(
            (lastRequestAt.getTime() - firstRequestAt.getTime()) / 1000
          )
        );
      } else if (firstRequestAt) {
        timeSpanSeconds = Math.max(
          1,
          Math.floor((now.getTime() - firstRequestAt.getTime()) / 1000)
        );
      }

      const avgTokensPerSecond =
        timeSpanSeconds > 0
          ? Math.round((totalTokens / timeSpanSeconds) * 100) / 100
          : 0;
      const avgRequestsPerMinute =
        timeSpanSeconds > 0
          ? Math.round((totalRequests / timeSpanSeconds) * 60 * 100) / 100
          : 0;

      statsMap.set(s.platformId, {
        totalRequests,
        totalTokens,
        promptTokens,
        completionTokens,
        avgTtft,
        avgDuration,
        avgTokensPerSecond,
        avgRequestsPerMinute,
        errorRequests: errorCountMap.get(s.platformId) || 0,
        firstRequestAt: firstRequestAt?.toISOString() || null,
      });
    }

    // 合并平台信息和统计数据
    const result = platforms.map((p) => {
      const pStats = statsMap.get(p.id) || {
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

      return serializeBigInt({
        id: p.id,
        name: p.name,
        type: p.type,
        enabled: p.enabled,
        status: p.status,
        baseUrl: p.baseUrl,
        createdAt: p.createdAt.toISOString(),
        stats: pStats,
      });
    });

    return NextResponse.json({
      success: true,
      data: result,
      total: result.length,
    });
  } catch (err) {
    console.error("[GET /api/admin/usage/platform] 获取平台用量失败:", err);
    return NextResponse.json(
      { success: false, error: "获取平台用量失败" },
      { status: 500 }
    );
  }
}
