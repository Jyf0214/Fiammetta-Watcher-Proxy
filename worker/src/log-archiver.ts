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
 * 归档互斥锁（configs 表租约）：cron 与手动归档并发进入时，后到者会抹掉
 * 先到者刚写入的聚合、重读「正在被删除」的日志，产生永久偏小的 daily_stats
 * 且日志删空后无法重算——拿不到锁必须跳过本次执行
 */
const ARCHIVE_LOCK_KEY = "system:log_archive_lock";
const ARCHIVE_LOCK_TTL_SEC = 30 * 60;

interface ArchiveLock {
  owner: string;
  expiresAt: number;
}

async function acquireArchiveLock(
  prisma: Awaited<ReturnType<typeof createDb>>
): Promise<string | null> {
  const nowSec = Math.floor(Date.now() / 1000);
  const owner = crypto.randomUUID();
  const value = JSON.stringify({ owner, expiresAt: nowSec + ARCHIVE_LOCK_TTL_SEC } satisfies ArchiveLock);
  try {
    const existing = await prisma.configs.findFirst({ where: { key: ARCHIVE_LOCK_KEY } });
    if (existing) {
      let held: ArchiveLock | null = null;
      try { held = JSON.parse(existing.value) as ArchiveLock; } catch { held = null; }
      // 他人持有且未过期：跳过本次（TTL 兜底持有者崩溃后的死锁）
      if (held && held.expiresAt > nowSec) return null;
      // 过期/损坏行：CAS 抢占（where value 精确匹配旧值，防双抢）
      const res = await prisma.configs.updateMany({
        where: { key: ARCHIVE_LOCK_KEY, value: existing.value },
        data: { value, updatedAt: nowSec },
      });
      return res.count === 1 ? owner : null;
    }
    await prisma.configs.create({
      data: { id: crypto.randomUUID(), key: ARCHIVE_LOCK_KEY, value, updatedAt: nowSec },
    });
    return owner;
  } catch (err) {
    // 创建锁行撞唯一约束 = 并发实例刚创建并持有；其余 DB 异常同样按拿不到锁处理
    console.warn("[log-archiver] 获取归档锁失败:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function releaseArchiveLock(
  prisma: Awaited<ReturnType<typeof createDb>>,
  owner: string
): Promise<void> {
  try {
    const existing = await prisma.configs.findFirst({ where: { key: ARCHIVE_LOCK_KEY } });
    if (!existing) return;
    let held: ArchiveLock | null = null;
    try { held = JSON.parse(existing.value) as ArchiveLock; } catch { held = null; }
    // 已易主（超时被抢占）则不动新持有者的锁
    if (held?.owner !== owner) return;
    await prisma.configs.deleteMany({ where: { key: ARCHIVE_LOCK_KEY, value: existing.value } });
  } catch (err) {
    console.error("[log-archiver] 释放归档锁失败:", err instanceof Error ? err.message : String(err));
  }
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
export async function runArchiveTask(db: D1Database, env?: WorkerEnv): Promise<{
  success: boolean;
  message: string;
  details?: { datesArchived: number; logsProcessed: number; logsDeleted: number };
}> {
  const now = Math.floor(Date.now() / 1000);
  const cutoffTs = now - RETENTION_DAYS * 86400;

  const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });

  // 并发互斥：拿不到锁直接跳过（cron 与手动触发撞车会永久损坏该天统计）
  const lockOwner = await acquireArchiveLock(prisma);
  if (!lockOwner) {
    console.warn("[log-archiver] 已有归档任务进行中，跳过本次执行");
    return { success: false, message: "已有归档任务进行中，本次跳过（防并发重算损坏统计）" };
  }

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
  } finally {
    await releaseArchiveLock(prisma, lockOwner);
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
 *
 * 内存安全：游标分页内每批立即聚合+写入+删除，不全量加载到内存。
 * groups 按 key+model 跨批合并（同一 key+model 可能出现在多个分页中）；
 * deleted 累计计数，不逐批清零。
 */
async function archiveSingleDay(
  prisma: Awaited<ReturnType<typeof createDb>>,
  dayStartTs: number,
  dayEndTs: number
): Promise<{ processed: number; deleted: number }> {
  const PAGE_SIZE = 10000;

  // 按 key_id + model 分组聚合（跨分页合并同 key+model 的数据）
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
      totalCost: number;
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

  let processed = 0;
  let deleted = 0;
  let cursor: { createdAt: number; id: string } | null = null;

  // 游标分页：每批读取后立即聚合，不全量积累 logs 数组
  for (;;) {
    const cursorWhere: any = cursor
      ? {
          OR: [
            { createdAt: { gt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { gt: cursor.id } },
          ],
        }
      : {};
    const batch: any[] = await prisma.requestLogs.findMany({
      where: {
        createdAt: { gte: dayStartTs, lte: dayEndTs },
        ...cursorWhere,
      },
      select: {
        id: true,
        keyId: true,
        keyName: true,
        platformId: true,
        model: true,
        tokens: true,
        promptTokens: true,
        completionTokens: true,
        cost: true,
        ttft: true,
        latency: true,
        isError: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: PAGE_SIZE,
    });

    if (batch.length === 0) {
      return { processed, deleted };
    }

    // 归档幂等（重算语义）：该天日志仍存在时，先清空该天的旧聚合记录再全量重算。
    // 仅在首批次发现日志时执行（空天不清除），避免无日志时多余清空；
    // 若中途失败（聚合写入后、日志删除前）次日重跑，日志仍在，重新清除旧聚合并重算。
    if (processed === 0) {
      await prisma.dailyStats.deleteMany({ where: { date: dayStartTs } });
    }

    // 立即聚合本批数据到 groups（跨批合并同 key+model 的统计）
    for (const log of batch) {
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
          totalCost: 0,
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

      group.totalRequests++;
      if (log.isError) {
        group.errorRequests++;
        continue;
      }

      group.totalTokens += log.tokens || 0;
      group.totalPromptTokens += log.promptTokens || 0;
      group.totalCompletionTokens += log.completionTokens || 0;
      group.totalCost += log.cost || 0;
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
      if (log.latency > 0 && log.completionTokens > 0) {
        const tps = log.completionTokens / (log.latency / 1000);
        group.tpsSum += tps;
        group.tpsCount++;
        if (tps > group.maxTps) group.maxTps = tps;
      }
    }

    // 立即删除本批日志（不等全量读完再删，减少内存占用）
    const batchIds = batch.map((log: any) => log.id);
    const DELETE_BATCH = 100;
    for (let i = 0; i < batchIds.length; i += DELETE_BATCH) {
      const r = await prisma.requestLogs.deleteMany({
        where: { id: { in: batchIds.slice(i, i + DELETE_BATCH) } },
      });
      deleted += r.count;
    }

    processed += batch.length;

    if (batch.length < PAGE_SIZE) break;
    const last = batch[batch.length - 1];
    cursor = { createdAt: last.createdAt, id: last.id };
  }

  if (groups.size === 0) {
    return { processed: 0, deleted };
  }

  // 批量写入聚合结果（分批 D1 100 行限制）
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = Array.from(groups.values()).map((group) => {
    const avgTtft = group.ttftCount > 0 ? group.ttftSum / group.ttftCount : 0;
    const avgDuration = group.latencyCount > 0 ? group.latencySum / group.latencyCount : 0;
    const avgTps = group.tpsCount > 0 ? group.tpsSum / group.tpsCount : 0;
    return {
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
      totalCost: group.totalCost,
      avgTtft,
      avgDuration,
      avgTps,
      maxTtft: group.maxTtft,
      maxDuration: group.maxLatency,
      maxTps: group.maxTps,
      createdAt: nowSec,
    };
  });
  for (let i = 0; i < rows.length; i += 100) {
    await prisma.dailyStats.createMany({ data: rows.slice(i, i + 100) });
  }

  return { processed, deleted };
}
