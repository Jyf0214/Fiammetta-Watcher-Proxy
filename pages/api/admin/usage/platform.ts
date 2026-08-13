/**
 * GET /api/admin/usage/platform — 获取平台维度用量统计
 *
 * 查询参数：
 * - period: 时间范围（today/week/month/all），默认 all
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/admin-auth";

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

    // 构建 Prisma where 条件（仅在指定了时间范围时添加 createdAt 过滤）
    const where = Object.fromEntries(
      Object.entries({
        createdAt: startTimestamp !== undefined ? { gte: startTimestamp } : undefined,
      }).filter(([, v]) => v !== undefined)
    );

    // 获取所有平台
    const allPlatforms = await orm.platforms.findMany({
      orderBy: { createdAt: "desc" },
    });

    // 用 groupBy 在数据库层面完成聚合，避免分页拉取全表日志到内存。
    // 注意：不能标注 any[]，否则会干扰 Prisma groupBy 泛型推断。
    const grouped = await orm.requestLogs.groupBy({
      by: ["platformId"],
      where,
      _count: { id: true },
      _sum: {
        tokens: true,
        promptTokens: true,
        completionTokens: true,
        ttft: true,
        latency: true,
      },
      _min: { createdAt: true },
      _max: { createdAt: true },
    });
    // 错误请求数：groupBy 的 _count 不支持带 where 过滤，需单独按 isError 聚合一次
    const errorGrouped = await orm.requestLogs.groupBy({
      by: ["platformId"],
      where: { ...where, isError: true },
      _count: { id: true },
    });

    const statsMap = new Map<string | null, typeof grouped[number]>(
      grouped.map((g) => [g.platformId, g])
    );
    const errorMap = new Map<string | null, number>(
      errorGrouped.map((g) => [g.platformId, g._count.id])
    );

    // 由 DB 层 groupBy 结果计算速率指标（口径与原分页聚合一致）
    function computeRates(g: typeof grouped[number], errorCount: number) {
      const totalRequests = g._count.id;
      const totalTokens = g._sum.tokens ?? 0;
      const sumPromptTokens = g._sum.promptTokens ?? 0;
      const sumCompletionTokens = g._sum.completionTokens ?? 0;
      const avgTtft = totalRequests > 0 ? Math.round((g._sum.ttft ?? 0) / totalRequests) : 0;
      const avgDuration = totalRequests > 0 ? Math.round((g._sum.latency ?? 0) / totalRequests) : 0;
      const firstRequestAt = g._min.createdAt ?? null;
      const lastRequestAt = g._max.createdAt ?? null;

      let timeSpanSeconds = 0;
      if (firstRequestAt != null && lastRequestAt != null) {
        timeSpanSeconds = Math.max(1, lastRequestAt - firstRequestAt);
      } else if (firstRequestAt != null) {
        timeSpanSeconds = Math.max(1, now - firstRequestAt);
      }

      return {
        totalRequests,
        totalTokens,
        promptTokens: sumPromptTokens,
        completionTokens: sumCompletionTokens,
        avgTtft,
        avgDuration,
        avgTokensPerSecond: timeSpanSeconds > 0
          ? Math.round((totalTokens / timeSpanSeconds) * 100) / 100
          : 0,
        avgRequestsPerMinute: timeSpanSeconds > 0
          ? Math.round(((totalRequests / timeSpanSeconds) * 60) * 100) / 100
          : 0,
        errorRequests: errorCount,
        firstRequestAt,
      };
    }

    // 合并平台信息和统计数据
    const result = allPlatforms.map((p) => {
      const g = statsMap.get(p.id);
      const rates = g ? computeRates(g, errorMap.get(p.id) ?? 0) : {
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
    const unknownGroup = statsMap.get(null);
    if (unknownGroup) {
      const rates = computeRates(unknownGroup, errorMap.get(null) ?? 0);
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
