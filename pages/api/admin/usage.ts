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

/** 单个 Key 的聚合统计结果 */
interface KeyAgg {
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

    // 构建 Prisma where 条件（createdAt 是 Int Unix 时间戳）
    const where: Record<string, unknown> = {};
    if (startTimestamp !== undefined) {
      where.createdAt = { gte: startTimestamp };
    }
    if (keyId) {
      where.keyId = keyId;
    }

    // 通过 ORM 获取所有匹配的请求日志
    const logs = await orm.requestLogs.findMany({
      where,
      select: {
        keyId: true,
        tokens: true,
        promptTokens: true,
        completionTokens: true,
        ttft: true,
        latency: true,
        createdAt: true,
      },
    });

    // 按 keyId 分组，手动计算聚合值
    const statsMap = new Map<string, KeyAgg>();

    for (const log of logs) {
      if (!log.keyId) continue;

      let agg = statsMap.get(log.keyId);
      if (!agg) {
        agg = {
          totalRequests: 0,
          totalTokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          avgTtft: 0,
          avgDuration: 0,
          firstRequestAt: null,
          lastRequestAt: null,
        };
        statsMap.set(log.keyId, agg);
      }

      agg.totalRequests += 1;
      agg.totalTokens += log.tokens ?? 0;
      agg.promptTokens += log.promptTokens ?? 0;
      agg.completionTokens += log.completionTokens ?? 0;

      // 累加用于计算平均值
      agg.avgTtft += log.ttft ?? 0;
      agg.avgDuration += log.latency ?? 0;

      // 记录最早和最晚请求时间（createdAt 已是 Unix 秒）
      const ts = log.createdAt;
      if (agg.firstRequestAt === null || ts < agg.firstRequestAt) {
        agg.firstRequestAt = ts;
      }
      if (agg.lastRequestAt === null || ts > agg.lastRequestAt) {
        agg.lastRequestAt = ts;
      }
    }

    // 计算平均值
    for (const agg of statsMap.values()) {
      if (agg.totalRequests > 0) {
        agg.avgTtft = Math.round(agg.avgTtft / agg.totalRequests);
        agg.avgDuration = Math.round(agg.avgDuration / agg.totalRequests);
      }
    }

    // 合并 Key 信息和统计数据
    const result = keys.map((k) => {
      const keyStats = statsMap.get(k.id);
      const totalTokens = keyStats?.totalTokens ?? 0;
      const totalRequests = keyStats?.totalRequests ?? 0;

      // 计算实际活动时间跨度
      let timeSpanSeconds = 0;
      if (keyStats?.firstRequestAt != null && keyStats?.lastRequestAt != null) {
        timeSpanSeconds = Math.max(1, keyStats.lastRequestAt - keyStats.firstRequestAt);
      } else if (keyStats?.firstRequestAt != null) {
        timeSpanSeconds = Math.max(1, now - keyStats.firstRequestAt);
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
          promptTokens: keyStats?.promptTokens ?? 0,
          completionTokens: keyStats?.completionTokens ?? 0,
          avgTtft: keyStats?.avgTtft ?? 0,
          avgDuration: keyStats?.avgDuration ?? 0,
          avgTokensPerSecond: timeSpanSeconds > 0
            ? Math.round((totalTokens / timeSpanSeconds) * 100) / 100
            : 0,
          avgRequestsPerMinute: timeSpanSeconds > 0
            ? Math.round(((totalRequests / timeSpanSeconds) * 60) * 100) / 100
            : 0,
          firstRequestAt: keyStats?.firstRequestAt ?? null,
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
