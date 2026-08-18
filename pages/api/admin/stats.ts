/**
 * GET /api/admin/stats — 获取仪表盘统计数据
 *
 * 返回：
 * - 启用平台数、API Key 数量（总数 + 活跃数）
 * - 请求总数、总 token
 * - 平均 TTFT 和平均耗时
 *
 * 性能说明（2026-08-12 优化）：
 * - 历史数据（已归档）从 daily_stats 聚合表读取，不再对 request_logs 全表扫描
 * - 未归档明细（最近 RETENTION_DAYS 天，界限与 worker/src/log-archiver.ts 归档
 *   条件一致）只做 createdAt 范围聚合（走 @@index([createdAt]) 索引）
 * - 聚合结果内存缓存 25s，吸收仪表盘 30s 自动刷新与高频手动刷新
 *
 * 归档/明细切分语义（与 log-archiver 对齐）：
 * - 归档按 UTC 天整块处理：所有"天开始时间戳 <= 归档截止天"的日志会被聚合进
 *   daily_stats 并从 request_logs 删除；因此 request_logs 只保留最近约
 *   RETENTION_DAYS 天（按 UTC 天粒度）的明细，daily_stats 只含更早的历史。
 * - 明细下界 = 今日 UTC 零点 - RETENTION_DAYS × 86400。归档最晚只能删到
 *   "今日零点 - RETENTION_DAYS 天"这一整天（即使归档今天已跑，daily_stats 的
 *   最大 date 也只到该天，而该天日志已删除），所以该界限与归档无重叠、无遗漏。
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/admin-auth";
import { RETENTION_DAYS } from "../../../worker/src/log-archiver";

/**
 * 缓存 TTL：25s。
 *
 * 前端仪表盘 30s 自动刷新（pages/admin/index.tsx AUTO_REFRESH_INTERVAL），
 * 若缓存 TTL 大于刷新间隔（如 60s），每次自动刷新都会命中缓存拿到旧值，
 * 数据在两次刷新间整体平移一个 TTL 周期；取 25s < 30s 保证每次自动刷新
 * 都必然触发重新计算，数据最大陈旧 25s，同时仍能吸收 30s 窗口内的重复
 * 手动刷新/多标签页请求，DB 压力约为原来的 1/2 以下。
 */
const CACHE_TTL_MS = 25_000;

/** 仪表盘统计数据（响应结构，与前端 pages/admin/index.tsx Stats 类型一致） */
interface StatsData {
  activePlatforms: number;
  totalKeys: number;
  activeKeys: number;
  totalRequests: number;
  totalTokens: number;
  avgTtft: number;
  avgDuration: number;
  avgTps: number;
}

/**
 * 模块级内存缓存（单实例内跨请求共享）。
 * 多实例部署下各实例缓存独立、数值最大偏差 25s——仪表盘为非强一致数据，可接受。
 */
let statsCache: { data: StatsData; expiresAt: number } | null = null;

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
    // 命中缓存直接返回，不查库（平台数/Key 数等小表查询也一并跳过）
    if (statsCache && statsCache.expiresAt > Date.now()) {
      res.status(200).json({ success: true, data: statsCache.data });
      return;
    }

    const db = await createDb();

    // 今日 UTC 零点（秒）。归档按 UTC 天切分，统计界限必须同用 UTC 天，否则
    // 本地时区与归档时区不一致会导致重复/遗漏
    const now = Math.floor(Date.now() / 1000);
    const todayStart = now - (now % 86400);

    // 历史（已归档）：daily_stats 全量行，在 JS 中累加。
    // 行数 = 归档天数 × (keyId, model) 组合数，管理后台规模下为万级；
    // 不直接用 SQL aggregate 是因为 avgTtft/avgDuration 是均值，
    // 加权平均需要逐行取 avg × 样本数，SQL 无法表达乘积和
    const histRows = await db.dailyStats.findMany({
      select: {
        totalRequests: true,
        errorRequests: true,
        totalTokens: true,
        avgTtft: true,
        avgDuration: true,
        avgTps: true,
      },
    });

    // 未归档明细下界：与 log-archiver 的归档截止天对齐（见文件头说明）。
    // 归档从未跑（daily_stats 为空）时不做下界限制、全量扫描明细兜底，
    // 避免统计永久缩水 RETENTION_DAYS 天（plan.md #26）
    const detailSince = histRows.length > 0 ? todayStart - RETENTION_DAYS * 86400 : 0;

    // 并行查询所有统计数据
    const [
      activePlatforms,
      totalKeys,
      activeKeys,
      detailAgg,
      perfAgg,
    ] = await Promise.all([
      // 启用的平台数
      db.platforms.count({ where: { enabled: true } }),
      // API Key 总数
      db.apiKeys.count(),
      // 活跃 API Key 数
      db.apiKeys.count({ where: { status: "active" } }),
      // 明细（未归档，含今日）：请求总数 + 总 token（含错误请求）
      db.requestLogs.aggregate({
        where: { createdAt: { gte: detailSince } },
        _count: { id: true },
        _sum: { tokens: true },
      }),
      // 明细性能统计：非错误请求的 TTFT/延迟/输出Token 总和（保持原接口口径）
      db.requestLogs.aggregate({
        where: { createdAt: { gte: detailSince }, isError: false },
        _count: { id: true },
        _sum: { ttft: true, latency: true, completionTokens: true },
      }),
    ]);

    // ---- 历史部分（daily_stats）累加 ----
    // 平均 TTFT/延迟的历史近似：
    // daily_stats 未存"ttft > 0 的样本数"。归档聚合（log-archiver）只对非错误
    // 请求累加 ttft/latency/tps 样本（错误请求仅计入 errorRequests），与明细
    // 部分口径一致；这里用每行 (totalRequests - errorRequests) 作为非错误请求
    // 数近似，并仅对 avgTtft > 0 的行把 avgTtft × 该数计入分子——与明细部分
    // "ttft=0 贡献 0 分子但计入分母"的稀释语义一致，是现有接口 avgTtft 口径
    // 在归档数据上的最佳近似（与 log-archiver 合并旧记录时"用总请求数近似
    // 样本数"同级）。
    let histRequests = 0;
    let histTokens = 0;
    let histPerfCount = 0;
    let histTtftSum = 0;
    let histLatencySum = 0;
    let histTpsSum = 0;
    let histTpsCount = 0;
    for (const row of histRows) {
      const perfCount = row.totalRequests - row.errorRequests;
      histRequests += row.totalRequests;
      histTokens += row.totalTokens;
      histPerfCount += perfCount;
      if (row.avgTtft > 0) histTtftSum += row.avgTtft * perfCount;
      if (row.avgDuration > 0) histLatencySum += row.avgDuration * perfCount;
      // avgTps > 0 表示有 TPS 样本，用 perfCount 近似样本数做加权平均
      if (row.avgTps > 0) {
        histTpsSum += row.avgTps * perfCount;
        histTpsCount += perfCount;
      }
    }

    // ---- 明细部分（request_logs，最近 RETENTION_DAYS 天）----
    const detailCount = detailAgg._count.id ?? 0;
    const detailTokens = detailAgg._sum.tokens ?? 0;
    const detailPerfCount = perfAgg._count.id ?? 0;
    const detailTtftSum = perfAgg._sum.ttft ?? 0;
    const detailLatencySum = perfAgg._sum.latency ?? 0;
    const detailCompletionTokens = perfAgg._sum.completionTokens ?? 0;

    // ---- 汇总 ----
    const totalRequests = histRequests + detailCount;
    const totalTokens = histTokens + detailTokens;
    const perfCount = histPerfCount + detailPerfCount;
    const ttftSum = histTtftSum + detailTtftSum;
    const latencySum = histLatencySum + detailLatencySum;
    const avgTtft = perfCount > 0 ? Math.round(ttftSum / perfCount) : 0;
    const avgDuration = perfCount > 0 ? Math.round(latencySum / perfCount) : 0;

    // TPS 汇总：历史加权平均 + 明细加权平均（completionTokens / latency_seconds）
    // 明细 TPS = 总输出Token / 总耗时秒数，本身已是加权平均，计为 1 个样本
    const detailTpsCount = detailLatencySum > 0 ? 1 : 0;
    const detailTpsSum = detailLatencySum > 0 ? (detailCompletionTokens / (detailLatencySum / 1000)) : 0;
    const totalTpsCount = histTpsCount + detailTpsCount;
    const totalTpsSum = histTpsSum + detailTpsSum;
    const avgTps = totalTpsCount > 0 ? Math.round((totalTpsSum / totalTpsCount) * 100) / 100 : 0;

    const data: StatsData = {
      activePlatforms,
      totalKeys,
      activeKeys,
      totalRequests,
      totalTokens,
      avgTtft,
      avgDuration,
      avgTps,
    };

    statsCache = { data, expiresAt: Date.now() + CACHE_TTL_MS };

    res.status(200).json({ success: true, data });
  } catch (err) {
    console.error("[GET /api/admin/stats] 获取统计数据失败:", err);
    res.status(500).json({ success: false, error: "获取统计数据失败" });
  }
}
