/**
 * 通知持久化存储
 *
 * 替换原进程内 Map/Set 实现的：
 * - 事件冷却去重：按 eventKey 持久化 lastSentAt
 *   取代原 `lastSentAt: Map<string, number>`；多实例部署保持一致
 * - 配额一次性提醒：按 (keyId, threshold) 唯一索引持久化
 *   取代原 `quotaNotifiedKeys: Set<string>`；重启/多实例不重发
 * - 发送历史：所有通知发送的 status/httpStatus/error/size/duration
 *   落库供管理后台"发送历史"页查询（queryHistory 接口在提交 5 admin API 接入）
 *
 * 设计要点：
 * - 内部统一调用 createDb()，与 prisma multi-dialect factory 兼容；
 *   消费方无需关心 db 绑定传递
 * - 冷却/配额写入采用 upsert + lastSentAt 时间戳；TTL 过期后下次调用放行
 * - history 写入失败不阻塞通知主流程（旁路能力）
 * - 清理过期 history 在提交 5 admin API 接入；当前仅保留 30 天基线
 */

import { createDb } from "@/lib/prisma";
import { QUOTA_THRESHOLDS, type QuotaThreshold } from "./notification-types";

/**
 * 检查事件是否处于冷却窗口内
 *
 * @param eventKey 业务侧去重键（如 `{event}:{platformId}`），空字符串表示全局冷却
 * @param cooldownMinutes 冷却窗口分钟数
 * @returns true = 在冷却中（应跳过）；false = 放行
 */
export async function checkCooldown(
  eventKey: string,
  cooldownMinutes: number
): Promise<boolean> {
  if (cooldownMinutes <= 0) return false;
  const db = await createDb();
  const now = Math.floor(Date.now() / 1000);
  const row = await db.notificationCooldowns.findUnique({
    where: { eventKey },
    select: { lastSentAt: true },
  });
  if (!row) return false;
  const elapsedMs = (now - row.lastSentAt) * 1000;
  return elapsedMs < cooldownMinutes * 60_000;
}

/** 记录一次通知发送（更新冷却时间戳） */
export async function recordSent(eventKey: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  try {
    const db = await createDb();
    await db.notificationCooldowns.upsert({
      where: { eventKey },
      create: {
        id: crypto.randomUUID(),
        eventKey,
        lastSentAt: now,
        updatedAt: now,
      },
      update: { lastSentAt: now, updatedAt: now },
    });
  } catch (err) {
    // 冷却写失败不阻塞主流程（旁路能力）；保留 lastSentAt 不更新即可
    console.error(
      "[notification-store] 冷却时间戳写入失败:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * 检测配额是否已通知（按档位）
 *
 * @returns true = 已通知过该档位（应跳过）；false = 应通知
 */
export async function checkQuotaNotified(
  keyId: string,
  threshold: QuotaThreshold
): Promise<boolean> {
  const db = await createDb();
  const row = await db.quotaNotified.findUnique({
    where: { keyId_threshold: { keyId, threshold } },
    select: { id: true },
  });
  return row !== null;
}

/** 标记某 Key 的某档位配额已通知 */
export async function markQuotaNotified(
  keyId: string,
  threshold: QuotaThreshold
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  try {
    const db = await createDb();
    await db.quotaNotified.upsert({
      where: { keyId_threshold: { keyId, threshold } },
      create: {
        id: crypto.randomUUID(),
        keyId,
        threshold,
        notifiedAt: now,
      },
      update: { notifiedAt: now },
    });
  } catch (err) {
    console.error(
      "[notification-store] 配额标记写入失败:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

/** 清除某 Key 的所有配额通知记录（Key 删除 / 重置时调用，避免孤儿数据） */
export async function clearQuotaNotified(keyId: string): Promise<void> {
  try {
    const db = await createDb();
    await db.quotaNotified.deleteMany({ where: { keyId } });
  } catch (err) {
    console.error(
      "[notification-store] 配额清理失败:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

export interface HistoryEntryInput {
  channelId: string;
  channelName: string;
  channelType: string;
  event: string;
  title: string;
  body: string;
  status: "success" | "failed";
  httpStatus?: number | null;
  error?: string | null;
  sizeBytes?: number;
  durationMs: number;
}

/**
 * 记录一次发送结果
 *
 * 失败仅 console.error，不抛出（旁路写入，不影响通知主流程）
 */
export async function recordHistory(entry: HistoryEntryInput): Promise<void> {
  try {
    const db = await createDb();
    await db.notificationHistory.create({
      data: {
        id: crypto.randomUUID(),
        channelId: entry.channelId,
        channelName: entry.channelName,
        channelType: entry.channelType,
        event: entry.event,
        title: entry.title,
        body: entry.body,
        status: entry.status,
        httpStatus: entry.httpStatus ?? null,
        error: entry.error ?? null,
        sizeBytes: entry.sizeBytes ?? 0,
        durationMs: entry.durationMs,
        sentAt: Math.floor(Date.now() / 1000),
      },
    });
  } catch (err) {
    console.error(
      "[notification-store] 发送历史写入失败:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

/** 查询发送历史（管理后台"发送历史"页使用） */
export interface HistoryQueryOptions {
  limit?: number;
  channelId?: string;
  event?: string;
  sinceSentAt?: number;
}

export interface HistoryRecord {
  id: string;
  channelId: string;
  channelName: string;
  channelType: string;
  event: string;
  title: string;
  body: string;
  status: string;
  httpStatus: number | null;
  error: string | null;
  sizeBytes: number;
  durationMs: number;
  sentAt: number;
}

export async function queryHistory(
  opts: HistoryQueryOptions = {}
): Promise<HistoryRecord[]> {
  const where: Record<string, unknown> = {};
  if (opts.channelId) where.channelId = opts.channelId;
  if (opts.event) where.event = opts.event;
  if (opts.sinceSentAt !== undefined) where.sentAt = { gte: opts.sinceSentAt };
  const db = await createDb();
  const rows = await db.notificationHistory.findMany({
    where,
    orderBy: { sentAt: "desc" },
    take: opts.limit ?? 50,
  });
  return rows.map((r) => ({
    id: r.id,
    channelId: r.channelId,
    channelName: r.channelName,
    channelType: r.channelType,
    event: r.event,
    title: r.title,
    body: r.body,
    status: r.status,
    httpStatus: r.httpStatus ?? null,
    error: r.error ?? null,
    sizeBytes: r.sizeBytes,
    durationMs: r.durationMs,
    sentAt: r.sentAt,
  }));
}

/**
 * 清理过期发送历史（cron 调用，按 retentionDays 阈值）
 *
 * @returns 删除条数（删除失败时返回 -1，不抛错）
 */
export async function purgeHistory(retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;
  try {
    const db = await createDb();
    const r = await db.notificationHistory.deleteMany({
      where: { sentAt: { lt: cutoff } },
    });
    return r.count;
  } catch (err) {
    console.error(
      "[notification-store] 历史清理失败:",
      err instanceof Error ? err.message : String(err)
    );
    return -1;
  }
}

/** 配额档位常量 re-export（便于消费方 import） */
export { QUOTA_THRESHOLDS };
