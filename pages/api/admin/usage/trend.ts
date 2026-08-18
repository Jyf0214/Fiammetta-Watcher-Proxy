/**
 * GET /api/admin/usage/trend — 获取请求量和 Token 使用趋势
 *
 * 查询参数：
 * - period: 时间范围（today/week/month/all），默认 month
 * - keyId: 可选，指定单个 Key ID
 *
 * 聚合粒度：
 * - today: 按小时聚合（显示 24 小时趋势）
 * - week/month/all: 按天聚合
 *
 * 性能说明（2026-08-12 优化）：
 * - 历史数据（已归档）从 daily_stats 聚合表读取，不再分页拉取全表日志。
 *   界限与 pages/api/admin/stats.ts 一致：明细下界 = 今日 UTC 零点 -
 *   RETENTION_DAYS × 86400，该界限前的数据读 daily_stats、之后读 request_logs。
 * - 请求数口径为全量（含错误请求），与仪表盘 stats.ts / 用量页 usage.ts 一致；
 *   TPS 用整体除法（片内输出 Token 总和 / 片内耗时秒数总和）。
 * - 未归档明细（最近 RETENTION_DAYS 天）只做 createdAt 范围过滤，
 *   走 @@index([createdAt]) 索引。
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/admin-auth";
import { RETENTION_DAYS } from "../../../../worker/src/log-archiver";

/** 趋势点数据（响应结构） */
interface TrendPoint {
  requests: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  /** 累计耗时（毫秒）：请求数/TPS 口径统一后的 TPS 用整体除法（输出Token/耗时秒） */
  latencyMs: number;
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

    const period = (req.query.period as string) || "month";
    const keyId = req.query.keyId as string | undefined;

    // 计算时间范围（Unix 时间戳，秒）
    const now = Math.floor(Date.now() / 1000);
    let startTimestamp: number;
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
      default: {
        // all：取最早请求时间（request_logs 与 daily_stats 中更早者）
        const [earliestLog, earliestHist] = await Promise.all([
          orm.requestLogs.findMany({
            orderBy: { createdAt: "asc" },
            take: 1,
            select: { createdAt: true },
          }),
          orm.dailyStats.findMany({
            orderBy: { date: "asc" },
            take: 1,
            select: { date: true },
          }),
        ]);
        startTimestamp = Math.min(
          earliestLog[0]?.createdAt ?? now,
          earliestHist[0]?.date ?? now
        );
      }
    }

    // 根据 period 决定聚合粒度：today 按小时，其他按天
    const isHourly = period === "today";

    // 归档/明细切分界限（与 stats.ts / log-archiver.ts 一致，见文件头说明）
    const todayStart = now - (now % 86400);
    const detailSince = todayStart - RETENTION_DAYS * 86400;

    // JS 按日期分组（键格式：today 用 'YYYY-MM-DD HH:00'，其他用 'YYYY-MM-DD'，本地时区）
    const groups = new Map<string, TrendPoint>();

    function addToGroup(dateKey: string, point: TrendPoint) {
      const existing = groups.get(dateKey);
      if (existing) {
        existing.requests += point.requests;
        existing.tokens += point.tokens;
        existing.promptTokens += point.promptTokens;
        existing.completionTokens += point.completionTokens;
        existing.latencyMs += point.latencyMs;
      } else {
        groups.set(dateKey, { ...point });
      }
    }

    function dateKeyOf(tsSec: number) {
      const d = new Date(tsSec * 1000);
      if (isHourly) {
        const hour = String(d.getHours()).padStart(2, "0");
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hour}:00`;
      }
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }

    // ---- 历史部分（daily_stats，仅 period=all 且存在早于明细下界的数据时触发）----
    if (startTimestamp < detailSince) {
      const histRows = await orm.dailyStats.findMany({
        where: {
          // 归档按天整块删除：最晚删到 detailSince 所在自然日一整天（归档截止
          // 时刻 cutoffTs 落在该天内，批次 endTs 截断到 cutoffTs 后仍按整天处理），
          // daily_stats 中该日记录 date = detailSince。历史查询必须含 detailSince，
          // 否则该天数据既不在历史也不在明细（request_logs 已删）→ 整日丢失
          date: { gte: startTimestamp, lte: detailSince },
          ...(keyId ? { keyId } : {}),
        },
        select: {
          date: true,
          totalRequests: true,
          errorRequests: true,
          totalTokens: true,
          totalPromptTokens: true,
          totalCompletionTokens: true,
          avgDuration: true,
        },
      });
      for (const row of histRows) {
        // 请求数含错误请求（与明细部分、仪表盘 stats.ts 口径一致）；
        // 错误请求 tokens 恒为 0，totalTokens 可近似非错误请求 tokens。
        // daily_stats 未存耗时总和，用 avgDuration × 非错误请求数近似
        // （与 stats.ts 历史 latencySum 累加口径一致），供片内整体除法 TPS
        const perfCount = row.totalRequests - row.errorRequests;
        addToGroup(dateKeyOf(row.date), {
          requests: row.totalRequests,
          tokens: row.totalTokens,
          promptTokens: row.totalPromptTokens,
          completionTokens: row.totalCompletionTokens,
          latencyMs: row.avgDuration > 0 ? row.avgDuration * perfCount : 0,
        });
      }
    }

    // ---- 明细部分（request_logs，最近 RETENTION_DAYS 天）----
    // 保留期与 period 范围取交集：下限取两者较晚者
    const detailStart = Math.max(startTimestamp, detailSince);
    // TiDB Cloud Serverless 单次查询硬上限 10000 行（服务端强制截断），
    // 必须分页循环拉取，否则统计只覆盖最早/最新 10000 条。
    const PAGE_SIZE = 10000;
    {
      let skip = 0;
      for (;;) {
        const batch = await orm.requestLogs.findMany({
          where: {
            createdAt: { gte: detailStart },
            ...(keyId ? { keyId } : {}),
          },
          select: {
            tokens: true,
            promptTokens: true,
            completionTokens: true,
            latency: true,
            isError: true,
            createdAt: true,
          },
          orderBy: { createdAt: "asc" },
          take: PAGE_SIZE,
          skip,
        });
        for (const log of batch) {
          addToGroup(dateKeyOf(log.createdAt), {
            requests: 1,
            tokens: log.tokens ?? 0,
            promptTokens: log.promptTokens ?? 0,
            completionTokens: log.completionTokens ?? 0,
            // 错误请求不计耗时：tokens 恒 0 但 latency 是真实耗时，计入会
            // 拉大 TPS 分母稀释均值（与 stats.ts perfAgg / 历史部分口径一致）
            latencyMs: log.isError ? 0 : log.latency,
          });
        }
        if (batch.length < PAGE_SIZE) break;
        skip += PAGE_SIZE;
      }
    }

    // 转为数组并按日期排序（与原 SQL ORDER BY date ASC 一致）
    const trend = Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, data]) => ({
        date,
        requests: data.requests,
        tokens: data.tokens,
        promptTokens: data.promptTokens,
        completionTokens: data.completionTokens,
        // TPS 整体除法口径（与仪表盘 stats.ts 明细部分一致）：
        // 片内输出 Token 总和 / 片内耗时秒数总和，而非每请求 TPS 的算术平均
        tps: data.latencyMs > 0 ? Math.round((data.completionTokens / (data.latencyMs / 1000)) * 100) / 100 : 0,
      }));

    res.status(200).json({ success: true, data: trend });
  } catch (err) {
    console.error("[GET /api/admin/usage/trend] 获取趋势数据失败:", err);
    res.status(500).json({ success: false, error: "获取趋势数据失败" });
  }
}
