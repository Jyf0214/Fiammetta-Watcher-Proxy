/**
 * 日志归档服务（Worker Cron）
 *
 * 每天凌晨自动将超过 RETENTION_DAYS 天的请求日志聚合为每日统计数据，
 * 写入 daily_stats 表后删除原始详细记录。
 *
 * 聚合维度：日期 + API Key + 模型
 * 聚合指标：总请求数、错误数、总 token、平均 TTFT、平均耗时等
 */

/** 日志保留天数，超过此天数的日志将被聚合归档 */
const RETENTION_DAYS = 30;

/** 每批处理的天数（防止一次性处理过多数据导致超时） */
const BATCH_SIZE = 7;

/** D1 查询结果基础类型 */
interface D1Row {
  [key: string]: unknown;
}

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
  // 计算截止日期（当前时间 - RETENTION_DAYS 天）
  const now = Math.floor(Date.now() / 1000);
  const cutoffTs = now - RETENTION_DAYS * 86400;

  // 查询最早的日志
  const oldestLog = await db
    .prepare("SELECT created_at FROM request_logs ORDER BY created_at ASC LIMIT 1")
    .first<{ created_at: number }>();

  if (!oldestLog) {
    return { success: true, message: "没有需要归档的日志" };
  }

  // 如果最早日志也在保留期内，无需归档
  if (oldestLog.created_at >= cutoffTs) {
    return { success: true, message: "所有日志均在保留期内，无需归档" };
  }

  const cutoffDate = new Date(cutoffTs * 1000).toISOString().slice(0, 10);
  const oldestDate = new Date(oldestLog.created_at * 1000).toISOString().slice(0, 10);
  console.log(`[log-archiver] 开始归档，截止日期: ${cutoffDate}，最早日志: ${oldestDate}`);

  // 按批次处理（从最早日志到截止日期）
  let totalDatesArchived = 0;
  let totalLogsProcessed = 0;
  let totalLogsDeleted = 0;

  // 从最早日志的那天开始，按 BATCH_SIZE 天一批
  let batchStartTs = oldestLog.created_at - (oldestLog.created_at % 86400); // 对齐到天的开始
  while (batchStartTs < cutoffTs) {
    let batchEndTs = batchStartTs + (BATCH_SIZE - 1) * 86400 + 86399; // 当天 23:59:59
    if (batchEndTs > cutoffTs) {
      batchEndTs = cutoffTs;
    }

    const result = await archiveLogs(db, batchStartTs, batchEndTs);
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
}

/**
 * 归档指定时间范围内的请求日志
 *
 * 按天遍历，将每天的日志按 key_id + model 分组聚合后写入 daily_stats，
 * 然后删除原始日志。
 */
async function archiveLogs(
  db: D1Database,
  startTs: number,
  endTs: number
): Promise<{ datesArchived: number; logsProcessed: number; logsDeleted: number }> {
  let datesArchived = 0;
  let totalLogsProcessed = 0;
  let totalLogsDeleted = 0;

  // 按天遍历
  let currentTs = startTs - (startTs % 86400); // 对齐到天开始
  while (currentTs <= endTs) {
    const dayStartTs = currentTs;
    const dayEndTs = currentTs + 86399; // 当天 23:59:59

    try {
      const result = await archiveSingleDay(db, dayStartTs, dayEndTs);
      totalLogsProcessed += result.processed;
      totalLogsDeleted += result.deleted;
      if (result.processed > 0) {
        datesArchived++;
      }
    } catch (err) {
      const dateStr = new Date(dayStartTs * 1000).toISOString().slice(0, 10);
      console.error(`[log-archiver] 归档日期 ${dateStr} 失败:`, err);
    }

    currentTs += 86400; // 下一天
  }

  return {
    datesArchived,
    logsProcessed: totalLogsProcessed,
    logsDeleted: totalLogsDeleted,
  };
}

/**
 * 归档单天的日志
 *
 * 查询该天所有日志，按 key_id + model 分组聚合，
 * 合并或创建 daily_stats 记录，然后删除原始日志。
 */
async function archiveSingleDay(
  db: D1Database,
  dayStartTs: number,
  dayEndTs: number
): Promise<{ processed: number; deleted: number }> {
  // 查询该天所有日志
  const logs = await db
    .prepare(
      `SELECT
         key_id, key_name, platform_id, model,
         tokens, prompt_tokens, completion_tokens,
         ttft, latency
       FROM request_logs
       WHERE created_at >= ? AND created_at <= ?`
    )
    .bind(dayStartTs, dayEndTs)
    .all<D1Row>();

  if (logs.results.length === 0) return { processed: 0, deleted: 0 };

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
      ttftCount: number; // ttft > 0 的数量
      latencySum: number;
      latencyCount: number; // latency > 0 的数量
      maxTtft: number;
      maxLatency: number;
    }
  >();

  for (const log of logs.results) {
    const groupKey = `${log.key_id || "null"}|||${log.model}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        keyId: log.key_id as string | null,
        keyName: log.key_name as string | null,
        platformId: log.platform_id as string | null,
        model: log.model as string,
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
    group.totalTokens += (log.tokens as number) || 0;
    group.totalPromptTokens += (log.prompt_tokens as number) || 0;
    group.totalCompletionTokens += (log.completion_tokens as number) || 0;
    const ttft = (log.ttft as number) || 0;
    const latency = (log.latency as number) || 0;
    if (ttft > 0) {
      group.ttftSum += ttft;
      group.ttftCount++;
    }
    if (latency > 0) {
      group.latencySum += latency;
      group.latencyCount++;
    }
    if (ttft > group.maxTtft) group.maxTtft = ttft;
    if (latency > group.maxLatency) group.maxLatency = latency;
  }

  // 聚合日期（daily_stats.date 为 Unix 时间戳，对齐到天的开始）
  const dayDateTs = dayStartTs;

  // 写入 daily_stats（同一天同一 Key 同一模型合并）
  for (const group of groups.values()) {
    const avgTtft =
      group.ttftCount > 0 ? group.ttftSum / group.ttftCount : 0;
    const avgDuration =
      group.latencyCount > 0 ? group.latencySum / group.latencyCount : 0;

    // 查找是否已有该维度的聚合记录
    const existing = await db
      .prepare(
        `SELECT id, total_requests, error_requests, total_tokens,
                total_prompt_tokens, total_completion_tokens,
                avg_ttft, avg_duration, max_ttft, max_duration
         FROM daily_stats
         WHERE date = ? AND key_id IS ? AND model = ?`
      )
      .bind(dayDateTs, group.keyId, group.model)
      .first<D1Row>();

    if (existing) {
      // 合并：累加计数，重新计算加权平均值
      const oldTotalRequests = existing.total_requests as number;
      const newTotalRequests = oldTotalRequests + group.totalRequests;
      const oldAvgTtft = existing.avg_ttft as number;
      const oldAvgDuration = existing.avg_duration as number;

      // 加权平均：新平均值 = (旧平均值 × 旧请求数 + 新总和) / 新总请求数
      const existingTtftCount =
        oldAvgTtft > 0 ? Math.round((oldAvgTtft * oldTotalRequests) / oldAvgTtft) : 0;

      const newAvgTtft =
        existingTtftCount + group.ttftCount > 0
          ? (oldAvgTtft * existingTtftCount + group.ttftSum) /
            (existingTtftCount + group.ttftCount)
          : 0;

      const newAvgDuration =
        newTotalRequests > 0
          ? (oldAvgDuration * oldTotalRequests + group.latencySum) /
            newTotalRequests
          : 0;

      await db
        .prepare(
          `UPDATE daily_stats SET
             total_requests = ?,
             error_requests = ?,
             total_tokens = ?,
             total_prompt_tokens = ?,
             total_completion_tokens = ?,
             avg_ttft = ?,
             avg_duration = ?,
             max_ttft = ?,
             max_duration = ?
           WHERE id = ?`
        )
        .bind(
          newTotalRequests,
          (existing.error_requests as number) + group.errorRequests,
          (existing.total_tokens as number) + group.totalTokens,
          (existing.total_prompt_tokens as number) + group.totalPromptTokens,
          (existing.total_completion_tokens as number) + group.totalCompletionTokens,
          newAvgTtft,
          newAvgDuration,
          Math.max(existing.max_ttft as number, group.maxTtft),
          Math.max(existing.max_duration as number, group.maxLatency),
          existing.id
        )
        .run();
    } else {
      // 创建新的聚合记录
      const insertTs = Math.floor(Date.now() / 1000);
      await db
        .prepare(
          `INSERT INTO daily_stats (
             id, date, key_id, key_name, platform_id, model,
             total_requests, error_requests, total_tokens,
             total_prompt_tokens, total_completion_tokens,
             avg_ttft, avg_duration, max_ttft, max_duration, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          `ds_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          dayDateTs,
          group.keyId,
          group.keyName,
          group.platformId,
          group.model,
          group.totalRequests,
          group.errorRequests,
          group.totalTokens,
          group.totalPromptTokens,
          group.totalCompletionTokens,
          avgTtft,
          avgDuration,
          group.maxTtft,
          group.maxLatency,
          insertTs
        )
        .run();
    }
  }

  // 删除该天的原始日志
  const deleteResult = await db
    .prepare(
      `DELETE FROM request_logs WHERE created_at >= ? AND created_at <= ?`
    )
    .bind(dayStartTs, dayEndTs)
    .run();

  return {
    processed: logs.results.length,
    deleted: deleteResult.meta?.changes ?? 0,
  };
}
