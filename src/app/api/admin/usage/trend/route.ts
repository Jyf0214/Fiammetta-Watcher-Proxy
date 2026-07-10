import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/auth";

/**
 * GET /api/admin/usage/trend — 获取请求量和 Token 使用趋势（按天聚合）
 *
 * 查询参数：
 * - period: 时间范围（today/week/month/all），默认 month
 * - keyId: 可选，指定单个 Key ID
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
    const period = searchParams.get("period") || "month";
    const keyId = searchParams.get("keyId");

    // 计算时间范围
    const now = new Date();
    let startDate: Date;
    switch (period) {
      case "today":
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case "week":
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case "month":
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      default: {
        // all：取最早请求时间
        const earliest = await prisma.requestLog.findFirst({
          orderBy: { createdAt: "asc" },
          select: { createdAt: true },
        });
        startDate = earliest?.createdAt || new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      }
    }

    // 使用 Prisma $queryRaw 按天聚合（MySQL DATE 函数）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = await prisma.$queryRaw`
      SELECT
        DATE(createdAt) as date,
        COUNT(*) as requests,
        COALESCE(SUM(tokens), 0) as tokens,
        COALESCE(SUM(promptTokens), 0) as promptTokens,
        COALESCE(SUM(completionTokens), 0) as completionTokens
      FROM request_logs
      WHERE createdAt >= ${startDate}
        AND isError = false
        ${keyId ? prisma.$queryRaw`AND keyId = ${keyId}` : prisma.$queryRaw``}
      GROUP BY DATE(createdAt)
      ORDER BY date ASC
    `;

    const trend = rows.map((row) => ({
      date: row.date instanceof Date
        ? row.date.toISOString().split("T")[0]
        : String(row.date),
      requests: Number(row.requests),
      tokens: Number(row.tokens),
      promptTokens: Number(row.promptTokens),
      completionTokens: Number(row.completionTokens),
    }));

    return NextResponse.json({ success: true, data: trend });
  } catch (err) {
    console.error("[GET /api/admin/usage/trend] 获取趋势数据失败:", err);
    return NextResponse.json(
      { success: false, error: "获取趋势数据失败" },
      { status: 500 }
    );
  }
}
