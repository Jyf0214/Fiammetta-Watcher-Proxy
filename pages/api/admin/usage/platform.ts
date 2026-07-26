/**
 * GET /api/admin/usage/platform — 获取平台维度用量统计
 *
 * 查询参数：
 * - period: 时间范围（today/week/month/all），默认 all
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest } from "../_auth";

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

    // 通过 Prisma ORM 获取所有匹配的日志记录
    const logs = await orm.requestLogs.findMany({
      where,
      select: {
        platformId: true,
        tokens: true,
        promptTokens: true,
        completionTokens: true,
        ttft: true,
        latency: true,
        createdAt: true,
        isError: true,
      },
    });

    // 按 platformId 分组，手动计算聚合值
    const grouped = new Map<string, typeof logs>();
    for (const log of logs) {
      const key = log.platformId || "unknown";
      const arr = grouped.get(key);
      if (arr) {
        arr.push(log);
      } else {
        grouped.set(key, [log]);
      }
    }

    // 计算速率指标的辅助函数
    function computeRates(logGroup: { tokens: number; promptTokens: number; completionTokens: number; ttft: number; latency: number; createdAt: number; isError: boolean }[]) {
      const totalRequests = logGroup.length;
      let totalTokens = 0;
      let sumPromptTokens = 0;
      let sumCompletionTokens = 0;
      let sumTtft = 0;
      let sumLatency = 0;
      let errorCount = 0;
      let minTtft = Infinity;
      let maxTtft = 0;
      let minLatency = Infinity;
      let maxLatency = 0;
      let firstRequestAt: number | null = null;
      let lastRequestAt: number | null = null;

      for (const log of logGroup) {
        totalTokens += log.tokens;
        sumPromptTokens += log.promptTokens;
        sumCompletionTokens += log.completionTokens;
        sumTtft += log.ttft;
        sumLatency += log.latency;
        if (log.isError) errorCount++;
        if (log.ttft < minTtft) minTtft = log.ttft;
        if (log.ttft > maxTtft) maxTtft = log.ttft;
        if (log.latency < minLatency) minLatency = log.latency;
        if (log.latency > maxLatency) maxLatency = log.latency;
        if (firstRequestAt === null || log.createdAt < firstRequestAt) firstRequestAt = log.createdAt;
        if (lastRequestAt === null || log.createdAt > lastRequestAt) lastRequestAt = log.createdAt;
      }

      const avgTtft = totalRequests > 0 ? Math.round(sumTtft / totalRequests) : 0;
      const avgDuration = totalRequests > 0 ? Math.round(sumLatency / totalRequests) : 0;

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
      const logGroup = grouped.get(p.id);
      const rates = logGroup ? computeRates(logGroup) : {
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
    const unknownGroup = grouped.get("unknown");
    if (unknownGroup && unknownGroup.length > 0) {
      const rates = computeRates(unknownGroup);
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
    res.status(500).json({ success: false, error: "获取平台用量失败", detail: err instanceof Error ? err.message : String(err) });
  }
}
