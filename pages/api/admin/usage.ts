/**
 * GET /api/admin/usage — 获取 API Key 用量统计（Key 维度）
 *
 * 查询参数：
 * - keyId: 可选，指定单个 Key ID
 * - period: 可选，时间范围（today/week/month/all），默认 all
 *
 * 响应（两种形态均含顶层 peakDuration，接口约定 F5）：
 * - peakDuration: 窗口内最大单请求耗时（秒，number|null；无有效耗时返回 null）。
 *   数据源 request_logs 最大 latency（毫秒，换算秒，仅非错误请求）+ period=all 时
 *   并入 daily_stats.maxDuration（已归档历史，归档时已排除错误请求）。
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb, type Prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/admin-auth";
import { checkAdminRateLimit } from "@/lib/admin-rate-limit";

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
  // 速率限制：防止 JWT 泄露后高频轮询枚举
  if (!await checkAdminRateLimit(admin.adminId, res)) return;

  try {
    const orm = await createDb();

    const keyId = req.query.keyId as string | undefined;
    const period = (req.query.period as string) || "all";

    // 计算时间过滤阈值（Unix 时间戳，秒）
    const now = Math.floor(Date.now() / 1000);
    let startTimestamp: number | undefined;
    switch (period) {
      case "today": {
        // UTC 零点（归档按 UTC 天切分，统计界限必须同用 UTC 天，见 stats.ts 同口径注释）
        const d = new Date();
        d.setUTCHours(0, 0, 0, 0);
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
    const where: Prisma.requestLogsWhereInput = {};
    if (startTimestamp !== undefined) {
      where.createdAt = { gte: startTimestamp };
    }
    if (keyId) {
      where.keyId = keyId;
    }

    // 用 groupBy 在数据库层面完成聚合，并行化 2 路查询（行为等价，P95 从 2*RTT 降至 1*RTT）
    const [grouped, perfGrouped] = await Promise.all([
      orm.requestLogs.groupBy({
        by: ["keyId"],
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
      }),
      // 性能统计（仅非错误请求）单独聚合：TTFT/耗时的平均分母只计非错误请求。
      orm.requestLogs.groupBy({
        by: ["keyId"],
        where: { ...where, isError: false },
        _count: { id: true },
        _sum: { ttft: true, latency: true },
      }),
    ]);
    const perfMap = new Map<string, typeof perfGrouped[number]>(
      perfGrouped
        .filter((g: typeof perfGrouped[number]) => g.keyId != null)
        .map((g: typeof perfGrouped[number]) => [g.keyId as string, g])
    );

    // 按 keyId 建索引
    const statsMap = new Map<string, typeof grouped[number]>(
      grouped
        .filter((g: typeof grouped[number]) => g.keyId != null)
        .map((g: typeof grouped[number]) => [g.keyId as string, g])
    );

    // ── period=all 历史部分（daily_stats 归档产物）──
    // 归档把 30 天前的明细从 request_logs 聚合进 daily_stats 后删除，
    // period=all 只查 request_logs 会永久缩水 30 天；daily_stats 未存 TTFT/
    // 耗时的样本总和，用"平均 × 非错误请求数"近似（与仪表盘 stats.ts 的
    // 历史累加口径一致），首末请求时间取 daily_stats 的日期范围并入。
    // 仅 period=all 需要：其他 period 的窗口内数据未归档，全部在 request_logs。
    const histByKey = new Map<
      string,
      {
        totalRequests: number;
        totalTokens: number;
        promptTokens: number;
        completionTokens: number;
        ttftSum: number;
        latencySum: number;
        perfCount: number;
        firstDate: number | null;
        lastDate: number | null;
      }
    >();
    // 已归档历史的最大单请求耗时（毫秒，daily_stats.maxDuration），
    // 仅 period=all 并入 peakDuration——与其余历史统计并入口径一致
    let histMaxDurationMs = 0;
    if (startTimestamp === undefined) {
      const histRows = await orm.dailyStats.findMany({
        where: keyId ? { keyId } : {},
        select: {
          keyId: true,
          date: true,
          totalRequests: true,
          errorRequests: true,
          totalTokens: true,
          totalPromptTokens: true,
          totalCompletionTokens: true,
          avgTtft: true,
          avgDuration: true,
          maxDuration: true,
        },
      });
      for (const row of histRows) {
        // 与明细口径一致：keyId 为 null 的日志不归属任何 Key，跳过
        if (!row.keyId) continue;
        const h = histByKey.get(row.keyId) ?? {
          totalRequests: 0,
          totalTokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          ttftSum: 0,
          latencySum: 0,
          perfCount: 0,
          firstDate: null,
          lastDate: null,
        };
        const perfCount = row.totalRequests - row.errorRequests;
        h.totalRequests += row.totalRequests;
        h.totalTokens += row.totalTokens;
        h.promptTokens += row.totalPromptTokens;
        h.completionTokens += row.totalCompletionTokens;
        h.perfCount += perfCount;
        // avg 为 0 表示该组无样本（ttft/latency > 0 才计入），权重取 0 避免稀释
        if (row.avgTtft > 0) h.ttftSum += row.avgTtft * perfCount;
        if (row.avgDuration > 0) h.latencySum += row.avgDuration * perfCount;
        if (h.firstDate === null || row.date < h.firstDate) h.firstDate = row.date;
        if (h.lastDate === null || row.date > h.lastDate) h.lastDate = row.date;
        histByKey.set(row.keyId, h);
        if (row.maxDuration > histMaxDurationMs) histMaxDurationMs = row.maxDuration;
      }
    }

    // 峰值耗时（peakDuration，接口约定 F5）：窗口内非错误请求的最大 latency（毫秒）。
    // 错误请求（超时/失败）写真实耗时且可能高达 120s，必须与 perfGrouped 同口径
    // 排除，否则峰值被错误请求污染、且与历史段 maxDuration（归档排除错误）口径分裂；
    // period=all 时历史部分（daily_stats.maxDuration）一并取最大，避免归档缩水。
    const peakAgg = await orm.requestLogs.aggregate({
      where: { ...where, isError: false },
      _max: { latency: true },
    });
    const peakLatencyMs = peakAgg._max.latency ?? 0;
    const peakDurationMs = Math.max(peakLatencyMs, histMaxDurationMs);
    // 换算为秒（number|null）：窗口内无任何有效耗时（无日志或全为错误请求）→ null
    const peakDuration = peakDurationMs > 0 ? Math.round(peakDurationMs / 1000) : null;

    // 合并 Key 信息和统计数据
    const result = keys.map((k: { id: string; name: string; key: string; status: string; tokenLimit: number | null; usedTokens: bigint; createdAt: number }) => {
      const g = statsMap.get(k.id);
      const h = histByKey.get(k.id);
      const pg = perfMap.get(k.id);
      const totalTokens = (g?._sum.tokens ?? 0) + (h?.totalTokens ?? 0);
      const totalRequests = (g?._count.id ?? 0) + (h?.totalRequests ?? 0);
      // 平均分母：仅非错误请求（明细 perfGrouped 计数 + 历史非错误请求数近似）
      const perfCount = (pg?._count.id ?? 0) + (h?.perfCount ?? 0);
      const ttftSum = (pg?._sum.ttft ?? 0) + (h?.ttftSum ?? 0);
      const latencySum = (pg?._sum.latency ?? 0) + (h?.latencySum ?? 0);
      // 首末请求时间：明细与历史（daily_stats 日期）取更早/更晚者
      const firstRequestAt = (() => {
        const candidates = [g?._min.createdAt ?? null, h?.firstDate ?? null].filter((v): v is number => v != null);
        return candidates.length > 0 ? Math.min(...candidates) : null;
      })();
      const lastRequestAt = (() => {
        const candidates = [g?._max.createdAt ?? null, h?.lastDate ?? null].filter((v): v is number => v != null);
        return candidates.length > 0 ? Math.max(...candidates) : null;
      })();

      // 计算实际活动时间跨度
      let timeSpanSeconds = 0;
      if (firstRequestAt != null && lastRequestAt != null) {
        timeSpanSeconds = Math.max(1, lastRequestAt - firstRequestAt);
      } else if (firstRequestAt != null) {
        timeSpanSeconds = Math.max(1, now - firstRequestAt);
      }

      // 速率指标（TPS/RPM）仅在请求数 ≥ 2 且首末请求存在真实跨度（不在同一秒）
      // 时才有统计意义：单请求/同秒突发时 firstRequestAt === lastRequestAt，
      // 跨度 0 被钳为 1 秒，会得到 TPS=该次请求 token 数、RPM=60 的失真值；
      // 此类情况统一返回 0（前端对 0 渲染 "-"）
      const rateValid = totalRequests >= 2 && firstRequestAt != null && lastRequestAt != null && lastRequestAt > firstRequestAt;

      return {
        id: k.id,
        name: k.name,
        key: maskKey(k.key),
        status: k.status,
        tokenLimit: k.tokenLimit,
        usedTokens: Number(k.usedTokens),
        createdAt: k.createdAt,
        stats: {
          totalRequests,
          totalTokens,
          promptTokens: (g?._sum.promptTokens ?? 0) + (h?.promptTokens ?? 0),
          completionTokens: (g?._sum.completionTokens ?? 0) + (h?.completionTokens ?? 0),
          avgTtft: perfCount > 0 ? Math.round(ttftSum / perfCount) : 0,
          avgDuration: perfCount > 0 ? Math.round(latencySum / perfCount) : 0,
          avgTokensPerSecond: rateValid && timeSpanSeconds > 0
            ? Math.round((totalTokens / timeSpanSeconds) * 100) / 100
            : 0,
          avgRequestsPerMinute: rateValid && timeSpanSeconds > 0
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
        peakDuration,
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: result,
      total: result.length,
      peakDuration,
    });
  } catch (err) {
    console.error("[GET /api/admin/usage] 获取用量统计失败:", err);
    res.status(500).json({ success: false, error: "获取用量统计失败" });
  }
}
