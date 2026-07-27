/**
 * GET /api/admin/usage — 获取 API Key 用量统计（Key 维度）
 *
 * 查询参数：
 * - keyId: 可选，指定单个 Key ID
 * - period: 可选，时间范围（today/week/month/all），默认 all
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb, type Prisma } from "@/lib/prisma";
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

    // 构建 Prisma where 条件（createdAt 是 Int Unix 时间戳）
    const where: Record<string, unknown> = {};
    if (startTimestamp !== undefined) {
      where.createdAt = { gte: startTimestamp };
    }
    if (keyId) {
      where.keyId = keyId;
    }

    // 用 groupBy 在数据库层面完成聚合，避免全量拉取日志到内存
    const grouped: any[] = await orm.requestLogs.groupBy({
      by: ["keyId"],
      where: where as Prisma.requestLogsWhereInput,
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

    // 按 keyId 建索引
    const statsMap = new Map<string, typeof grouped[number]>(
      grouped
        .filter((g: typeof grouped[number]) => g.keyId != null)
        .map((g: typeof grouped[number]) => [g.keyId as string, g])
    );

    // 合并 Key 信息和统计数据
    const result = keys.map((k: { id: string; name: string; key: string; status: string; tokenLimit: number | null; usedTokens: number; createdAt: number }) => {
      const g = statsMap.get(k.id);
      const totalTokens = g?._sum.tokens ?? 0;
      const totalRequests = g?._count.id ?? 0;
      const firstRequestAt = g?._min.createdAt ?? null;
      const lastRequestAt = g?._max.createdAt ?? null;

      // 计算实际活动时间跨度
      let timeSpanSeconds = 0;
      if (firstRequestAt != null && lastRequestAt != null) {
        timeSpanSeconds = Math.max(1, lastRequestAt - firstRequestAt);
      } else if (firstRequestAt != null) {
        timeSpanSeconds = Math.max(1, now - firstRequestAt);
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
          promptTokens: g?._sum.promptTokens ?? 0,
          completionTokens: g?._sum.completionTokens ?? 0,
          avgTtft: totalRequests > 0 ? Math.round((g?._sum.ttft ?? 0) / totalRequests) : 0,
          avgDuration: totalRequests > 0 ? Math.round((g?._sum.latency ?? 0) / totalRequests) : 0,
          avgTokensPerSecond: timeSpanSeconds > 0
            ? Math.round((totalTokens / timeSpanSeconds) * 100) / 100
            : 0,
          avgRequestsPerMinute: timeSpanSeconds > 0
            ? Math.round(((totalRequests / timeSpanSeconds) * 60) * 100) / 100
            : 0,
          firstRequestAt,
        },
      };
    });

    // 如果指定了 keyId，只返回该 Key 的数据
    if (keyId) {
      const filtered = result.filter((r: { id: string }) => r.id === keyId);
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
    res.status(500).json({ success: false, error: "获取用量统计失败" });
  }
}
