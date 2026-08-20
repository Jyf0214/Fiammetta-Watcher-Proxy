/**
 * GET /api/admin/usage/platform — 获取平台维度用量统计
 *
 * 查询参数：
 * - period: 时间范围（today/week/month/all），默认 all
 *
 * 口径（与 usage.ts Key 维度对齐）：
 * - 请求数/Token 为全量（含错误请求）；TTFT/耗时均值分母只计非错误请求
 *   （perfGrouped 按 isError:false 聚合，错误请求真实耗时最高 120s 不抬高均值）
 * - period=all 时并入 daily_stats 已归档历史（按 platformId 聚合，
 *   避免 log-archiver 归档后总量永久缩水）
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

    // 性能统计（仅非错误请求）单独聚合：TTFT/耗时的平均分母只计非错误请求。
    // 错误请求的 latency/ttft 是真实耗时（非 0，超时最高 120s），若计入分母会
    // 系统性抬高均值（与 usage.ts 的 perfGrouped / 仪表盘 stats.ts perfAgg 口径一致）
    const perfGrouped = await orm.requestLogs.groupBy({
      by: ["platformId"],
      where: { ...where, isError: false },
      _count: { id: true },
      _sum: { ttft: true, latency: true },
    });

    const statsMap = new Map<string | null, typeof grouped[number]>(
      grouped.map((g) => [g.platformId, g])
    );
    const errorMap = new Map<string | null, number>(
      errorGrouped.map((g) => [g.platformId, g._count.id])
    );
    const perfMap = new Map<string | null, typeof perfGrouped[number]>(
      perfGrouped.map((g) => [g.platformId, g])
    );

    // daily_stats 历史并入的按平台累计结构（见下方 period=all 并入块）
    interface HistEntry {
      totalRequests: number;
      errorRequests: number;
      totalTokens: number;
      promptTokens: number;
      completionTokens: number;
      ttftSum: number;
      latencySum: number;
      perfCount: number;
      firstDate: number | null;
      lastDate: number | null;
    }

    // 由 DB 层 groupBy 结果计算速率指标（口径与原分页聚合一致）。
    // 明细（request_logs groupBy）+ 历史（daily_stats，仅 period=all 有值）
    // 合并；均值分母用 perfGrouped 非错误请求计数 + 历史非错误请求数近似。
    function computeRates(
      g: typeof grouped[number] | undefined,
      errorCount: number,
      h: HistEntry | undefined,
      pg: typeof perfGrouped[number] | undefined
    ) {
      const totalRequests = (g?._count.id ?? 0) + (h?.totalRequests ?? 0);
      const totalTokens = (g?._sum.tokens ?? 0) + (h?.totalTokens ?? 0);
      const sumPromptTokens = (g?._sum.promptTokens ?? 0) + (h?.promptTokens ?? 0);
      const sumCompletionTokens = (g?._sum.completionTokens ?? 0) + (h?.completionTokens ?? 0);
      // 平均分母：仅非错误请求（明细 perfGrouped 计数 + 历史非错误请求数近似）
      const perfCount = (pg?._count.id ?? 0) + (h?.perfCount ?? 0);
      const ttftSum = (pg?._sum.ttft ?? 0) + (h?.ttftSum ?? 0);
      const latencySum = (pg?._sum.latency ?? 0) + (h?.latencySum ?? 0);
      const avgTtft = perfCount > 0 ? Math.round(ttftSum / perfCount) : 0;
      const avgDuration = perfCount > 0 ? Math.round(latencySum / perfCount) : 0;
      // 首末请求时间：明细与历史（daily_stats 日期）取更早/更晚者
      const firstRequestAt = (() => {
        const candidates = [g?._min.createdAt ?? null, h?.firstDate ?? null].filter((v): v is number => v != null);
        return candidates.length > 0 ? Math.min(...candidates) : null;
      })();
      const lastRequestAt = (() => {
        const candidates = [g?._max.createdAt ?? null, h?.lastDate ?? null].filter((v): v is number => v != null);
        return candidates.length > 0 ? Math.max(...candidates) : null;
      })();

      let timeSpanSeconds = 0;
      if (firstRequestAt != null && lastRequestAt != null) {
        timeSpanSeconds = Math.max(1, lastRequestAt - firstRequestAt);
      } else if (firstRequestAt != null) {
        timeSpanSeconds = Math.max(1, now - firstRequestAt);
      }

      // 速率指标（TPS/RPM）仅在请求数 ≥ 2 且首末请求存在真实跨度（不在同一秒）
      // 时才有统计意义：单请求/同秒突发时 firstRequestAt === lastRequestAt，
      // 跨度 0 被钳为 1 秒，会得到 TPS=该次请求 token 数、RPM=60 的失真值；
      // 此类情况统一返回 0（前端对 0 渲染 "-"）——与 usage.ts 同口径
      const rateValid = totalRequests >= 2 && firstRequestAt != null && lastRequestAt != null && lastRequestAt > firstRequestAt;

      return {
        totalRequests,
        totalTokens,
        promptTokens: sumPromptTokens,
        completionTokens: sumCompletionTokens,
        avgTtft,
        avgDuration,
        avgTokensPerSecond: rateValid && timeSpanSeconds > 0
          ? Math.round((totalTokens / timeSpanSeconds) * 100) / 100
          : 0,
        avgRequestsPerMinute: rateValid && timeSpanSeconds > 0
          ? Math.round(((totalRequests / timeSpanSeconds) * 60) * 100) / 100
          : 0,
        errorRequests: errorCount + (h?.errorRequests ?? 0),
        firstRequestAt,
      };
    }

    // ── period=all 历史部分（daily_stats 归档产物）──
    // 归档把 30 天前的明细从 request_logs 聚合进 daily_stats 后删除，period=all
    // 只查 request_logs 会永久缩水。daily_stats 含 platformId 字段（log-archiver
    // 按 keyId+model 分组归档时记录平台），按 platformId 聚合并入（对齐
    // usage.ts 的 keyId 并入模式）。
    // 注意近似点（与 usage.ts 同源）：daily_stats 未存 TTFT/耗时的样本总和，
    // 用"平均 × 非错误请求数"近似（与仪表盘 stats.ts 历史累加口径一致）；
    // 且归档行按 keyId+model 分组、platformId 取组内首条日志，同一 key 跨平台
    // 使用时历史平台归属存在近似。platformId 为 null 的历史行不归属任何平台，跳过。
    // 仅 period=all 需要：其他 period 的窗口内数据未归档，全部在 request_logs。
    const histByPlatform = new Map<string, HistEntry>();
    if (startTimestamp === undefined) {
      const histRows = await orm.dailyStats.findMany({
        select: {
          platformId: true,
          date: true,
          totalRequests: true,
          errorRequests: true,
          totalTokens: true,
          totalPromptTokens: true,
          totalCompletionTokens: true,
          avgTtft: true,
          avgDuration: true,
        },
      });
      for (const row of histRows) {
        // 与明细口径一致：platformId 为 null 的日志不归属任何平台，跳过
        if (!row.platformId) continue;
        const h = histByPlatform.get(row.platformId) ?? {
          totalRequests: 0,
          errorRequests: 0,
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
        h.errorRequests += row.errorRequests;
        h.totalTokens += row.totalTokens;
        h.promptTokens += row.totalPromptTokens;
        h.completionTokens += row.totalCompletionTokens;
        h.perfCount += perfCount;
        // avg 为 0 表示该组无样本（ttft/latency > 0 才计入），权重取 0 避免稀释
        if (row.avgTtft > 0) h.ttftSum += row.avgTtft * perfCount;
        if (row.avgDuration > 0) h.latencySum += row.avgDuration * perfCount;
        if (h.firstDate === null || row.date < h.firstDate) h.firstDate = row.date;
        if (h.lastDate === null || row.date > h.lastDate) h.lastDate = row.date;
        histByPlatform.set(row.platformId, h);
      }
    }

    // 合并平台信息和统计数据
    const result = allPlatforms.map((p) => {
      const g = statsMap.get(p.id);
      const h = histByPlatform.get(p.id);
      const pg = perfMap.get(p.id);
      // 有明细或有历史（仅历史数据时也需展示，避免归档后平台统计归零）
      const rates = g || h ? computeRates(g, errorMap.get(p.id) ?? 0, h, pg) : {
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
    // 历史部分（daily_stats）platformId 为 null 的行已在并入时跳过，此处仅明细
    const unknownGroup = statsMap.get(null);
    if (unknownGroup) {
      const rates = computeRates(unknownGroup, errorMap.get(null) ?? 0, undefined, perfMap.get(null));
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
