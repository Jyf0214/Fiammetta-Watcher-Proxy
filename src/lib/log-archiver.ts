/**
 * 日志归档服务
 *
 * 每天自动将超过 RETENTION_DAYS 天的请求日志聚合为每日统计数据，
 * 写入 DailyStats 表后删除原始详细记录。
 *
 * 聚合维度：日期 + API Key + 模型
 * 聚合指标：总请求数、错误数、总 token、输入/输出 token、平均 TTFT、平均耗时等
 */

import { prisma } from "./prisma";

/** 日志保留天数，超过此天数的日志将被聚合归档 */
const RETENTION_DAYS = 30;

/** 每批处理的日期数量（防止一次性处理过多数据导致内存溢出） */
const BATCH_SIZE = 7;

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * 归档指定日期范围内的请求日志
 *
 * @param startDate 归档起始日期（含）
 * @param endDate 归档结束日期（含）
 * @returns 归档的日期数和处理的日志条数
 */
export async function archiveLogs(
  startDate: Date,
  endDate: Date
): Promise<{ datesArchived: number; logsProcessed: number; logsDeleted: number }> {
  let datesArchived = 0;
  let totalLogsProcessed = 0;
  let totalLogsDeleted = 0;

  // 按天遍历
  const current = new Date(startDate);
  current.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  while (current <= end) {
    const dayStart = new Date(current);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(current);
    dayEnd.setHours(23, 59, 59, 999);

    try {
      const result = await archiveSingleDay(dayStart, dayEnd);
      totalLogsProcessed += result.processed;
      totalLogsDeleted += result.deleted;
      if (result.processed > 0) {
        datesArchived++;
      }
    } catch (err) {
      console.error(
        `[log-archiver] 归档日期 ${dayStart.toISOString().slice(0, 10)} 失败:`,
        err
      );
    }

    current.setDate(current.getDate() + 1);
  }

  return {
    datesArchived,
    logsProcessed: totalLogsProcessed,
    logsDeleted: totalLogsDeleted,
  };
}

/**
 * 归档单天的日志
 */
async function archiveSingleDay(
  dayStart: Date,
  dayEnd: Date
): Promise<{ processed: number; deleted: number }> {
  // 查询该天所有日志，按 keyId + model 分组聚合
  const logs = await prisma.requestLog.findMany({
    where: {
      createdAt: {
        gte: dayStart,
        lte: dayEnd,
      },
    },
    select: {
      keyId: true,
      platformId: true,
      model: true,
      tokens: true,
      promptTokens: true,
      completionTokens: true,
      ttft: true,
      duration: true,
      isError: true,
      key: { select: { name: true } },
      platform: { select: { name: true } },
    },
  });

  if (logs.length === 0) return { processed: 0, deleted: 0 };

  // 按 keyId + model 分组
  const groups = new Map<
    string,
    {
      keyId: string | null;
      keyName: string | null;
      platformId: string | null;
      platformName: string | null;
      model: string;
      totalRequests: number;
      errorRequests: number;
      totalTokens: number;
      totalPromptTokens: number;
      totalCompletionTokens: number;
      ttftSum: number;
      ttftCount: number; // ttft > 0 的数量
      durationSum: number;
      durationCount: number; // duration > 0 的数量
      maxTtft: number;
      maxDuration: number;
    }
  >();

  for (const log of logs) {
    const groupKey = `${log.keyId || "null"}|||${log.model}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        keyId: log.keyId,
        keyName: log.key?.name ?? null,
        platformId: log.platformId,
        platformName: log.platform?.name ?? null,
        model: log.model,
        totalRequests: 0,
        errorRequests: 0,
        totalTokens: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        ttftSum: 0,
        ttftCount: 0,
        durationSum: 0,
        durationCount: 0,
        maxTtft: 0,
        maxDuration: 0,
      };
      groups.set(groupKey, group);
    }

    group.totalRequests++;
    if (log.isError) group.errorRequests++;
    group.totalTokens += log.tokens;
    group.totalPromptTokens += log.promptTokens;
    group.totalCompletionTokens += log.completionTokens;
    if (log.ttft > 0) {
      group.ttftSum += log.ttft;
      group.ttftCount++;
    }
    if (log.duration > 0) {
      group.durationSum += log.duration;
      group.durationCount++;
    }
    if (log.ttft > group.maxTtft) group.maxTtft = log.ttft;
    if (log.duration > group.maxDuration) group.maxDuration = log.duration;
  }

  // 写入 DailyStats（同一天同一 Key 同一模型合并）
  const dateOnly = new Date(dayStart);
  dateOnly.setHours(0, 0, 0, 0);

  for (const group of groups.values()) {
    const avgTtft = group.ttftCount > 0 ? group.ttftSum / group.ttftCount : 0;
    const avgDuration =
      group.durationCount > 0 ? group.durationSum / group.durationCount : 0;

    // 查找是否已有该维度的聚合记录
    const existing = await prisma.dailyStats.findFirst({
      where: {
        date: dateOnly,
        keyId: group.keyId,
        model: group.model,
      },
    });

    if (existing) {
      // 合并：累加计数，重新计算平均值
      // 注意：DailyStats 表没有记录有 TTFT/Duration 数据的请求数
      // 使用加权平均公式：新平均值 = (旧平均值 × 旧请求数 + 新总和) / (旧请求数 + 新请求数)
      // 这里假设所有请求都有 duration 数据，但只有流式请求有 ttft 数据
      const newTotalRequests = existing.totalRequests + group.totalRequests;
      const newTtftSum =
        existing.avgTtft * existing.totalRequests + group.ttftSum;
      const newDurationSum =
        existing.avgDuration * existing.totalRequests + group.durationSum;
      // 估算原有有 TTFT 数据的请求数：avgTtft > 0 说明有数据，按比例估算
      const existingTtftCount = existing.avgTtft > 0
        ? Math.round((existing.avgTtft * existing.totalRequests) / existing.avgTtft)
        : 0;

      await prisma.dailyStats.update({
        where: { id: existing.id },
        data: {
          totalRequests: newTotalRequests,
          errorRequests: existing.errorRequests + group.errorRequests,
          totalTokens: existing.totalTokens + group.totalTokens,
          totalPromptTokens: existing.totalPromptTokens + group.totalPromptTokens,
          totalCompletionTokens:
            existing.totalCompletionTokens + group.totalCompletionTokens,
          avgTtft:
            existingTtftCount + group.ttftCount > 0
              ? newTtftSum / (existingTtftCount + group.ttftCount)
              : 0,
          avgDuration:
            newTotalRequests > 0
              ? newDurationSum / newTotalRequests
              : 0,
          maxTtft: Math.max(existing.maxTtft, group.maxTtft),
          maxDuration: Math.max(existing.maxDuration, group.maxDuration),
          platformName: group.platformName ?? existing.platformName,
          keyName: group.keyName ?? existing.keyName,
        },
      });
    } else {
      await prisma.dailyStats.create({
        data: {
          date: dateOnly,
          keyId: group.keyId,
          keyName: group.keyName,
          platformId: group.platformId,
          platformName: group.platformName,
          model: group.model,
          totalRequests: group.totalRequests,
          errorRequests: group.errorRequests,
          totalTokens: group.totalTokens,
          totalPromptTokens: group.totalPromptTokens,
          totalCompletionTokens: group.totalCompletionTokens,
          avgTtft,
          avgDuration,
          maxTtft: group.maxTtft,
          maxDuration: group.maxDuration,
        },
      });
    }
  }

  // 删除该天的原始日志
  const deleteResult = await prisma.requestLog.deleteMany({
    where: {
      createdAt: {
        gte: dayStart,
        lte: dayEnd,
      },
    },
  });

  return {
    processed: logs.length,
    deleted: deleteResult.count,
  };
}

/**
 * 执行归档任务
 *
 * 计算截止日期（当前时间 - RETENTION_DAYS 天），
 * 归档该日期之前的所有日志。
 */
export async function runArchiveTask(): Promise<{
  success: boolean;
  message: string;
  details?: { datesArchived: number; logsProcessed: number; logsDeleted: number };
}> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);
  cutoffDate.setHours(0, 0, 0, 0);

  // 查询最早的日志时间
  const oldestLog = await prisma.requestLog.findFirst({
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });

  if (!oldestLog) {
    return { success: true, message: "没有需要归档的日志" };
  }

  // 如果最早日志也在保留期内，无需归档
  const retentionStart = new Date();
  retentionStart.setDate(retentionStart.getDate() - RETENTION_DAYS);
  retentionStart.setHours(0, 0, 0, 0);

  if (oldestLog.createdAt >= retentionStart) {
    return { success: true, message: "所有日志均在保留期内，无需归档" };
  }

  console.log(
    `[log-archiver] 开始归档，截止日期: ${cutoffDate.toISOString().slice(0, 10)}，最早日志: ${oldestLog.createdAt.toISOString().slice(0, 10)}`
  );

  // 按批次处理
  const batchStart = new Date(oldestLog.createdAt);
  batchStart.setHours(0, 0, 0, 0);
  let totalDatesArchived = 0;
  let totalLogsProcessed = 0;
  let totalLogsDeleted = 0;

  const batchEnd = new Date(batchStart);
  while (batchStart < cutoffDate) {
    batchEnd.setDate(batchStart.getDate() + BATCH_SIZE - 1);
    if (batchEnd > cutoffDate) {
      batchEnd.setTime(cutoffDate.getTime());
    }

    const result = await archiveLogs(
      new Date(batchStart),
      new Date(batchEnd)
    );
    totalDatesArchived += result.datesArchived;
    totalLogsProcessed += result.logsProcessed;
    totalLogsDeleted += result.logsDeleted;

    batchStart.setDate(batchStart.getDate() + BATCH_SIZE);
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
}

/**
 * 启动日志归档调度器
 *
 * 每天凌晨 3:00 执行一次归档任务。
 * 首次调用延迟 5 分钟执行（等待系统启动完成）。
 */
export function startLogArchiver(): void {
  if (timer) return;

  console.log(
    `[log-archiver] 启动日志归档调度器，保留 ${RETENTION_DAYS} 天，每天凌晨 3:00 执行`
  );

  // 首次延迟 5 分钟执行
  setTimeout(() => {
    runArchiveTask().catch((err) => {
      console.error("[log-archiver] 首次归档任务执行失败:", err);
    });
  }, 5 * 60 * 1000);

  // 每天执行一次（24 小时 = 86400000 毫秒）
  timer = setInterval(() => {
    runArchiveTask().catch((err) => {
      console.error("[log-archiver] 归档任务执行失败:", err);
    });
  }, 24 * 60 * 60 * 1000);
}

/**
 * 停止日志归档调度器
 */
export function stopLogArchiver(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
