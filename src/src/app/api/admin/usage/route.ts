import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/auth";
import { serializeBigInt } from "@/lib/serialize";

/**
 * GET /api/admin/usage — 获取 API Key 用量统计
 *
 * 查询参数：
 * - keyId: 可选，指定单个 Key ID
 * - period: 可选，时间范围（today/week/month/all），默认 all
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
    const keyId = searchParams.get("keyId");
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
    if (keyId) {
      whereClause.keyId = keyId;
    }
    if (dateFilter) {
      whereClause.createdAt = { gte: dateFilter };
    }

    // 获取所有 API Key
    const keys = await prisma.apiKey.findMany({
      select: {
        id: true,
        name: true,
        key: true,
        status: true,
        tokenLimit: true,
        usedTokens: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    // 获取每个 Key 的请求统计
    const stats = await prisma.requestLog.groupBy({
      by: ["keyId"],
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

    // 计算每个 Key 的统计指标
    const statsMap = new Map<string, {
      totalRequests: number;
      totalTokens: number;
      promptTokens: number;
      completionTokens: number;
      avgTtft: number;
      avgDuration: number;
      avgTokensPerSecond: number;
      avgRequestsPerMinute: number;
      firstRequestAt: string | null;
    }>();

    for (const s of stats) {
      if (s.keyId === null) continue;

      const totalTokens = s._sum.tokens || 0;
      const promptTokens = s._sum.promptTokens || 0;
      const completionTokens = s._sum.completionTokens || 0;
      const totalRequests = s._count;
      const avgTtft = Math.round(s._avg.ttft || 0);
      const avgDuration = Math.round(s._avg.duration || 0);

      // 计算实际活动时间跨度（首个请求到最后一个请求）
      const firstRequestAt = s._min.createdAt;
      const lastRequestAt = s._max.createdAt;
      let timeSpanSeconds = 0;
      if (firstRequestAt && lastRequestAt) {
        // 使用实际活动时间跨度，最小 1 秒避免除零
        timeSpanSeconds = Math.max(
          1,
          Math.floor((lastRequestAt.getTime() - firstRequestAt.getTime()) / 1000)
        );
      } else if (firstRequestAt) {
        // 只有一个请求时，使用当前时间
        timeSpanSeconds = Math.max(
          1,
          Math.floor((now.getTime() - firstRequestAt.getTime()) / 1000)
        );
      }

      // 计算速率指标
      const avgTokensPerSecond =
        timeSpanSeconds > 0
          ? Math.round((totalTokens / timeSpanSeconds) * 100) / 100
          : 0;
      const avgRequestsPerMinute =
        timeSpanSeconds > 0
          ? Math.round(((totalRequests / timeSpanSeconds) * 60) * 100) / 100
          : 0;

      statsMap.set(s.keyId, {
        totalRequests,
        totalTokens,
        promptTokens,
        completionTokens,
        avgTtft,
        avgDuration,
        avgTokensPerSecond,
        avgRequestsPerMinute,
        firstRequestAt: firstRequestAt?.toISOString() || null,
      });
    }

    // 合并 Key 信息和统计数据
    const result = keys.map((k) => {
      const keyStats = statsMap.get(k.id) || {
        totalRequests: 0,
        totalTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        avgTtft: 0,
        avgDuration: 0,
        avgTokensPerSecond: 0,
        avgRequestsPerMinute: 0,
        firstRequestAt: null,
      };

      // 掩码处理
      const maskedKey =
        k.key.length > 12
          ? k.key.substring(0, 8) + "..." + k.key.substring(k.key.length - 4)
          : "***";

      return serializeBigInt({
        id: k.id,
        name: k.name,
        key: maskedKey,
        status: k.status,
        tokenLimit: k.tokenLimit,
        usedTokens: k.usedTokens,
        createdAt: k.createdAt.toISOString(),
        stats: keyStats,
      });
    });

    // 如果指定了 keyId，只返回该 Key 的数据
    if (keyId) {
      const filtered = result.filter((r) => r.id === keyId);
      return NextResponse.json({
        success: true,
        data: filtered.length > 0 ? filtered[0] : null,
      });
    }

    return NextResponse.json({
      success: true,
      data: result,
      total: result.length,
    });
  } catch (err) {
    console.error("[GET /api/admin/usage] 获取用量统计失败:", err);
    return NextResponse.json(
      {
        success: false,
        error: "获取用量统计失败",
      },
      { status: 500 }
    );
  }
}
