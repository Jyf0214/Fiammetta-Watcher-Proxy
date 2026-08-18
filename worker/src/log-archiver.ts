/**
 * 日志归档服务（Worker Cron）
 *
 * 每天凌晨自动将超过 RETENTION_DAYS 天的请求日志聚合为每日统计数据，
 * 写入 daily_stats 表后删除原始详细记录。
 *
 * 聚合维度：日期 + API Key + 模型
 * 聚合指标：总请求数、错误数、总 token、平均 TTFT、平均耗时等
 */

import { createDb } from "@/lib/prisma";
import type { WorkerEnv } from "./config";

/**
 * 日志保留天数，超过此天数的日志将被聚合归档
 *
 * 导出供 pages/api/admin/stats.ts 复用：仪表盘统计按同一界限切分
 * （date >= 今日零点 - RETENTION_DAYS 的明细仍留在 request_logs，更早的读 daily_stats），
 * 保证"未归档明细 + 已归档历史"不重复、不遗漏。
 */
export const RETENTION_DAYS = 30;

/** 每批处理的天数（防止一次性处理过多数据导致超时） */
const BATCH_SIZE = 7;

/** 合理时间戳下限：2024-01-01T00:00:00Z（秒）——早于项目存在的日志视为异常数据 */
const MIN_VALID_TS = 1704067200;

/**
 * 执行日志归档任务
 *
 * 将超过保留期的 request_logs 记录聚合为 daily_stats 后删除原始记录。
 * 聚合维度：日期 + API Key + 模型。
 *
 * @param db - D1 数据库实例
 * @returns 归档结果
 */
export async function runArchiveTask(db: D1Database, env?: WorkerEnv): Promise<{
  success: boolean;
  message: string;
  details?: { datesArchived: number; logsProcessed: number; logsDeleted: number };
}> {
  const now = Math.floor(Date.now() / 1000);
  const cutoffTs = now - RETENTION_DAYS * 86400;

  const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
  try {
    // 清理异常时间戳日志（如导入备份带入的 2009 年测试数据）：
    // 不聚合不保留，避免污染 daily_stats 统计
    const nowPlus1d = now + 86400;
    const invalidDeleted = await prisma.requestLogs.deleteMany({
      where: {
        OR: [
          { createdAt: { lt: MIN_VALID_TS } },
          { createdAt: { gt: nowPlus1d } },
        ],
      },
    });
    if (invalidDeleted.count > 0) {
      console.log(`[log-archiver] 清理 ${invalidDeleted.count} 条异常时间戳日志`);
    }

    const oldestLog = await prisma.requestLogs.findFirst({
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    });

    if (!oldestLog) {
      return { success: true, message: "没有需要归档的日志" };
    }

    if (oldestLog.createdAt >= cutoffTs) {
      return { success: true, message: "所有日志均在保留期内，无需归档" };
    }

    const cutoffDate = new Date(cutoffTs * 1000).toISOString().slice(0, 10);
    const oldestDate = new Date(oldestLog.createdAt * 1000).toISOString().slice(0, 10);
    console.log(`[log-archiver] 开始归档，截止日期: ${cutoffDate}，最早日志: ${oldestDate}`);

    let totalDatesArchived = 0;
    let totalLogsProcessed = 0;
    let totalLogsDeleted = 0;

    let batchStartTs = oldestLog.createdAt - (oldestLog.createdAt % 86400);
    while (batchStartTs < cutoffTs) {
      let batchEndTs = batchStartTs + (BATCH_SIZE - 1) * 86400 + 86399;
      if (batchEndTs > cutoffTs) {
        batchEndTs = cutoffTs;
      }

      const result = await archiveLogs(prisma, batchStartTs, batchEndTs);
      totalDatesArchived += result.datesArchived;
      totalLogsProcessed += result.logsProcessed;
      totalLogsDeleted += result.logsDeleted;

      batchStartTs += BATCH_SIZE * 86400;
    }

    const message = `归档完成: ${totalDatesArchived} 天, ${totalLogsProcessed} 条日志处理, ${totalLogsDeleted} 条已删除${
      invalidDeleted.count > 0 ? `, 清理 ${invalidDeleted.count} 条异常时间戳日志` : ""
    }`;
    console.log(`[log-archiver] ${message}`);

    return {
      success: true,
      message,
      details: {
        datesArchived: totalDatesArchived,
        logsProcessed: totalLogsProcessed,
        logsDeleted: totalLogsDeleted,
      },
    };
  } catch (err) {
    console.error("[log-archiver] 归档任务异常:", err instanceof Error ? err.message : String(err));
    return {
      success: false,
      message: `归档失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * 归档指定时间范围内的请求日志
 */
async function archiveLogs(
  prisma: Awaited<ReturnType<typeof createDb>>,
  startTs: number,
  endTs: number
): Promise<{ datesArchived: number; logsProcessed: number; logsDeleted: number }> {
  let datesArchived = 0;
  let totalLogsProcessed = 0;
  let totalLogsDeleted = 0;

  let currentTs = startTs - (startTs % 86400);
  while (currentTs <= endTs) {
    const dayStartTs = currentTs;
    const dayEndTs = currentTs + 86399;

    try {
      const result = await archiveSingleDay(prisma, dayStartTs, dayEndTs);
      totalLogsProcessed += result.processed;
      totalLogsDeleted += result.deleted;
      if (result.processed > 0) {
        datesArchived++;
      }
    } catch (err) {
      const dateStr = new Date(dayStartTs * 1000).toISOString().slice(0, 10);
      console.error(`[log-archiver] 归档日期 ${dateStr} 失败:`, err);
    }

    currentTs += 86400;
  }

  return { datesArchived, logsProcessed: totalLogsProcessed, logsDeleted: totalLogsDeleted };
}

/**
 * 归档单天的日志
 *
 * 查询该天所有日志，按 key_id + model 分组聚合，
 * 合并或创建 daily_stats 记录，然后删除原始日志。
 */
async function archiveSingleDay(
  prisma: Awaited<ReturnType<typeof createDb>>,
  dayStartTs: number,
  dayEndTs: number
): Promise<{ processed: number; deleted: number }> {
  // TiDB Cloud Serverless 单次查询硬上限 10000 行（服务端强制截断），
  // 分页循环拉取当天全部日志，避免超出部分未被聚合
  const PAGE_SIZE = 10000;
  const where = { createdAt: { gte: dayStartTs, lte: dayEndTs } };
  const logs: Array<{
    id: string;
    keyId: string | null;
    keyName: string | null;
    platformId: string | null;
    model: string;
    tokens: number;
    promptTokens: number;
    completionTokens: number;
    ttft: number;
    latency: number;
    isError: boolean;
  }> = [];
  const logIds: string[] = [];
  {
    let skip = 0;
    for (;;) {
      const batch = await prisma.requestLogs.findMany({
        where,
        select: {
          id: true,
          keyId: true,
          keyName: true,
          platformId: true,
          model: true,
          tokens: true,
          promptTokens: true,
          completionTokens: true,
          ttft: true,
          latency: true,
          isError: true,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: PAGE_SIZE,
        skip,
      });
      logs.push(...batch);
      for (const log of batch) logIds.push(log.id);
      if (batch.length < PAGE_SIZE) break;
      skip += PAGE_SIZE;
    }
  }

  if (logs.length === 0) return { processed: 0, deleted: 0 };

  // 归档幂等（重算语义）：该天日志仍存在时，先清空该天的旧聚合记录再全量重算。
  // 归档中途失败（聚合写入后、日志删除前）次日重跑时，若不清空旧聚合而直接累加，
  // 同一批日志会被计两次（daily_stats 纯加法无唯一约束，plan.md #27）；
  // 完全成功归档后重跑时日志已删空，上方已提前返回，聚合记录不会被清除。
  await prisma.dailyStats.deleteMany({ where: { date: dayStartTs } });

  // 按 key_id + model 分组聚合
  const groups = new Map<
    string,
    {
      keyId: string | null;
      keyName: string | null;
      platformId: string | null;
      model: string;
      totalRequests: number;
      errorRequests: number;
      totalTokens: number;
      totalPromptTokens: number;
      totalCompletionTokens: number;
      ttftSum: number;
      ttftCount: number;
      latencySum: number;
      latencyCount: number;
      maxTtft: number;
      maxLatency: number;
      tpsSum: number;
      tpsCount: number;
      maxTps: number;
    }
  >();

  for (const log of logs) {
    const groupKey = `${log.keyId || "null"}|||${log.model}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        keyId: log.keyId,
        keyName: log.keyName,
        platformId: log.platformId,
        model: log.model,
        totalRequests: 0,
        errorRequests: 0,
        totalTokens: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        ttftSum: 0,
        ttftCount: 0,
        latencySum: 0,
        latencyCount: 0,
        maxTtft: 0,
        maxLatency: 0,
        tpsSum: 0,
        tpsCount: 0,
        maxTps: 0,
      };
      groups.set(groupKey, group);
    }

    // 总请求数含错误请求（与 stats.ts detailAgg 无 isError 过滤的口径一致）
    group.totalRequests++;

    // 错误请求只计入 errorRequests，不贡献 tokens/ttft/latency/tps：
    // 与明细统计口径一致（stats.ts/trend.ts 的 perfAgg 按 isError:false 过滤，
    // 错误请求 tokens 恒为 0、ttft=0 会稀释均值）。此前未读 isError 字段导致
    // errorRequests 恒为 0，历史部分 perfCount=totalRequests 把错误请求误当样本。
    if (log.isError) {
      group.errorRequests++;
      continue;
    }

    group.totalTokens += log.tokens || 0;
    group.totalPromptTokens += log.promptTokens || 0;
    group.totalCompletionTokens += log.completionTokens || 0;
    if (log.ttft > 0) {
      group.ttftSum += log.ttft;
      group.ttftCount++;
    }
    if (log.latency > 0) {
      group.latencySum += log.latency;
      group.latencyCount++;
    }
    if (log.ttft > group.maxTtft) group.maxTtft = log.ttft;
    if (log.latency > group.maxLatency) group.maxLatency = log.latency;
    // TPS = 每秒输出 Token 数（completionTokens / latency_seconds）
    // 只对有有效耗时和输出 token 的请求计算
    if (log.latency > 0 && log.completionTokens > 0) {
      const tps = log.completionTokens / (log.latency / 1000);
      group.tpsSum += tps;
      group.tpsCount++;
      if (tps > group.maxTps) group.maxTps = tps;
    }
  }

  for (const group of groups.values()) {
    const avgTtft = group.ttftCount > 0 ? group.ttftSum / group.ttftCount : 0;
    const avgDuration = group.latencyCount > 0 ? group.latencySum / group.latencyCount : 0;
    const avgTps = group.tpsCount > 0 ? group.tpsSum / group.tpsCount : 0;

    // 该天旧聚合已在开头清空，此处直接创建（重算语义，无累加分支）
    await prisma.dailyStats.create({
      data: {
        id: `ds_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        date: dayStartTs,
        keyId: group.keyId,
        keyName: group.keyName,
        platformId: group.platformId,
        model: group.model,
        totalRequests: group.totalRequests,
        errorRequests: group.errorRequests,
        totalTokens: group.totalTokens,
        totalPromptTokens: group.totalPromptTokens,
        totalCompletionTokens: group.totalCompletionTokens,
        avgTtft,
        avgDuration,
        avgTps,
        maxTtft: group.maxTtft,
        maxDuration: group.maxLatency,
        maxTps: group.maxTps,
        createdAt: Math.floor(Date.now() / 1000),
      },
    });
  }

  // 删除该天已归档的原始日志（按已收集的 id 分批删除，
  // 避免按整天时间范围误删未被分页拉取到的部分）
  let deleted = 0;
  const DELETE_BATCH = 5000;
  for (let i = 0; i < logIds.length; i += DELETE_BATCH) {
    const r = await prisma.requestLogs.deleteMany({
      where: { id: { in: logIds.slice(i, i + DELETE_BATCH) } },
    });
    deleted += r.count;
  }

  return {
    processed: logs.length,
    deleted,
  };
}
