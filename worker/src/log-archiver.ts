/**
 * 日志归档服务（Worker Cron）
 *
 * 每天凌晨自动将超过 RETENTION_DAYS 天的请求日志聚合为每日统计数据，
 * 写入 daily_stats 表后删除原始详细记录。
 *
 * 聚合维度：日期 + API Key + 模型
 * 聚合指标：总请求数、错误数、总 token、平均 TTFT、平均耗时等
 */

import { createPrismaClient } from "./prisma-db";

/** 日志保留天数，超过此天数的日志将被聚合归档 */
const RETENTION_DAYS = 30;

/** 每批处理的天数（防止一次性处理过多数据导致超时） */
const BATCH_SIZE = 7;

/**
 * 执行日志归档任务
 *
 * 将超过保留期的 request_logs 记录聚合为 daily_stats 后删除原始记录。
 * 聚合维度：日期 + API Key + 模型。
 *
 * @param db - D1 数据库实例
 * @returns 归档结果
 */
export async function runArchiveTask(db: D1Database): Promise<{
  success: boolean;
  message: string;
  details?: { datesArchived: number; logsProcessed: number; logsDeleted: number };
}> {
  const now = Math.floor(Date.now() / 1000);
  const cutoffTs = now - RETENTION_DAYS * 86400;

  const prisma = await createPrismaClient(db);
  try {
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

    const message = `归档完成: ${totalDatesArchived} 天, ${totalLogsProcessed} 条日志处理, ${totalLogsDeleted} 条已删除`;
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
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * 归档指定时间范围内的请求日志
 */
async function archiveLogs(
  prisma: Awaited<ReturnType<typeof createPrismaClient>>,
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
  prisma: Awaited<ReturnType<typeof createPrismaClient>>,
  dayStartTs: number,
  dayEndTs: number
): Promise<{ processed: number; deleted: number }> {
  const logs = await prisma.requestLogs.findMany({
    where: {
      createdAt: { gte: dayStartTs, lte: dayEndTs },
    },
    select: {
      keyId: true,
      keyName: true,
      platformId: true,
      model: true,
      tokens: true,
      promptTokens: true,
      completionTokens: true,
      ttft: true,
      latency: true,
    },
  });

  if (logs.length === 0) return { processed: 0, deleted: 0 };

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
      };
      groups.set(groupKey, group);
    }

    group.totalRequests++;
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
  }

  const dayDateTs = dayStartTs;

  for (const group of groups.values()) {
    const avgTtft = group.ttftCount > 0 ? group.ttftSum / group.ttftCount : 0;
    const avgDuration = group.latencyCount > 0 ? group.latencySum / group.latencyCount : 0;

    // 查找已有聚合记录
    const existing = await prisma.dailyStats.findFirst({
      where: {
        date: dayDateTs,
        keyId: group.keyId,
        model: group.model,
      },
      select: {
        id: true,
        totalRequests: true,
        errorRequests: true,
        totalTokens: true,
        totalPromptTokens: true,
        totalCompletionTokens: true,
        avgTtft: true,
        avgDuration: true,
        maxTtft: true,
        maxDuration: true,
      },
    });

    if (existing) {
      const oldTotalRequests = existing.totalRequests;
      const newTotalRequests = oldTotalRequests + group.totalRequests;
      const existingTtftCount =
        existing.avgTtft > 0 ? Math.round((existing.avgTtft * oldTotalRequests) / existing.avgTtft) : 0;

      const newAvgTtft =
        existingTtftCount + group.ttftCount > 0
          ? (existing.avgTtft * existingTtftCount + group.ttftSum) /
            (existingTtftCount + group.ttftCount)
          : 0;

      const newAvgDuration =
        newTotalRequests > 0
          ? (existing.avgDuration * oldTotalRequests + group.latencySum) /
            newTotalRequests
          : 0;

      await prisma.dailyStats.update({
        where: { id: existing.id },
        data: {
          totalRequests: newTotalRequests,
          errorRequests: existing.errorRequests + group.errorRequests,
          totalTokens: existing.totalTokens + group.totalTokens,
          totalPromptTokens: existing.totalPromptTokens + group.totalPromptTokens,
          totalCompletionTokens: existing.totalCompletionTokens + group.totalCompletionTokens,
          avgTtft: newAvgTtft,
          avgDuration: newAvgDuration,
          maxTtft: Math.max(existing.maxTtft, group.maxTtft),
          maxDuration: Math.max(existing.maxDuration, group.maxLatency),
        },
      });
    } else {
      await prisma.dailyStats.create({
        data: {
          id: `ds_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          date: dayDateTs,
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
          maxTtft: group.maxTtft,
          maxDuration: group.maxLatency,
          createdAt: Math.floor(Date.now() / 1000),
        },
      });
    }
  }

  // 删除该天的原始日志
  const deleteResult = await prisma.requestLogs.deleteMany({
    where: {
      createdAt: { gte: dayStartTs, lte: dayEndTs },
    },
  });

  return {
    processed: logs.length,
    deleted: deleteResult.count,
  };
}
