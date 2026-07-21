/**
 * Cron Trigger 处理器
 *
 * 根据 cron 表达式分发到不同定时任务：
 * - 每小时（0 /1 * * *）：API Key 用量重置
 * - 每 10 分钟（/10 * * * *）：平台模型自动发现
 * - 每天凌晨 3 点（0 3 * * *）：日志归档 + 过期日志清理
 *
 * 每个任务独立 try/catch，一个任务失败不影响其他任务执行。
 * 使用 Drizzle ORM 操作 D1 数据库。
 */

import type { Env } from "../types";
import { createDb } from "../db";
import {
  requestLogs,
  apiKeys,
  platforms,
  platformModels,
  dailyStats,
  auditLogs,
  systemEvents,
} from "../db/schema";
import { eq, lte, gte, sql, and } from "drizzle-orm";
import { detectModelType } from "../lib/model-type";
import { parseApiKeys } from "../lib/platform-keys";

/** 模型拉取超时时间（毫秒） */
const FETCH_TIMEOUT_MS = 10_000;

/** 日志保留天数，超过此天数的日志将被归档删除 */
const RETENTION_DAYS = 30;

/** 每批处理的日期数量（防止一次性处理过多数据导致内存溢出） */
const BATCH_SIZE = 7;

/**
 * Cron 触发器入口函数
 *
 * 根据 event.cron 匹配到的 cron 表达式，分发执行对应的任务。
 */
export async function handleCron(
  event: ScheduledEvent,
  env: Env
): Promise<void> {
  const cronExpr = event.cron;

  if (cronExpr.includes("0 */1")) {
    // 每小时: API Key 用量重置
    await runApiKeyReset(env).catch((err) => {
      console.error("[cron:api-key-reset] 任务失败:", err);
    });
  } else if (cronExpr.includes("*/10")) {
    // 每 10 分钟: 平台模型自动发现
    await runModelFetcher(env).catch((err) => {
      console.error("[cron:model-fetcher] 任务失败:", err);
    });
  } else if (cronExpr.includes("0 3")) {
    // 每天凌晨 3 点: 日志归档 + 过期日志清理
    await runLogArchiver(env).catch((err) => {
      console.error("[cron:log-archiver] 任务失败:", err);
    });
  }
}

// ==================== API Key 用量重置 ====================

/**
 * 判断指定 API Key 是否需要在当前周期重置
 *
 * 使用 updatedAt 字段判断：如果上次更新日期与当前日期不在同一周期，则需要重置。
 * 这样即使服务重启，也不会重复重置（因为重置后 updatedAt 会更新到当前时间）。
 */
function needsReset(apiKey: {
  resetPeriod: string | null;
  updatedAt: string;
}): boolean {
  const now = new Date();
  const updated = new Date(apiKey.updatedAt);

  switch (apiKey.resetPeriod) {
    case "daily":
      // 上次更新日期与今天不同 → 需要重置
      return updated.toDateString() !== now.toDateString();

    case "monthly":
      // 上次更新月份与当前月份不同 → 需要重置
      return (
        updated.getMonth() !== now.getMonth() ||
        updated.getFullYear() !== now.getFullYear()
      );

    case "never":
    default:
      return false;
  }
}

/**
 * 计算当前周期的起始时间（ISO 字符串）
 *
 * daily: 今天凌晨 00:00:00
 * monthly: 本月 1 号凌晨 00:00:00
 */
function getPeriodStart(resetPeriod: string): string {
  const now = new Date();
  if (resetPeriod === "daily") {
    now.setHours(0, 0, 0, 0);
  } else {
    // monthly: 从当月1号开始
    now.setDate(1);
    now.setHours(0, 0, 0, 0);
  }
  return now.toISOString();
}

/**
 * 执行 API Key 用量重置
 *
 * 查询所有 resetPeriod !== "never" 的 API Key，
 * 逐个检查是否需要重置。重置操作包括：
 * 1. usedTokens 归零
 * 2. status 恢复为 active（防止超限禁用在新周期仍生效）
 * 3. 删除当前周期之前的请求日志（使 callLimit 同步重置）
 */
async function runApiKeyReset(env: Env): Promise<void> {
  const db = createDb(env.DB);
  const now = new Date().toISOString();

  try {
    // 查询所有 resetPeriod 不为 never 的 API Key
    const keysToCheck = await db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        resetPeriod: apiKeys.resetPeriod,
        usedTokens: apiKeys.usedTokens,
        status: apiKeys.status,
        updatedAt: apiKeys.updatedAt,
      })
      .from(apiKeys)
      .where(sql`${apiKeys.resetPeriod} != 'never'`);

    let resetCount = 0;

    for (const key of keysToCheck) {
      if (!needsReset(key)) continue;

      try {
        const periodStart = getPeriodStart(key.resetPeriod ?? "monthly");

        // 归零 usedTokens，恢复被禁用的 Key
        await db
          .update(apiKeys)
          .set({
            usedTokens: 0,
            status: key.status === "disabled" ? "active" : key.status,
            updatedAt: now,
          })
          .where(eq(apiKeys.id, key.id));

        // 删除当前周期之前的请求日志（使 callLimit 同步重置）
        await db
          .delete(requestLogs)
          .where(
            and(
              eq(requestLogs.keyId, key.id),
              lte(requestLogs.createdAt, periodStart)
            )
          );

        resetCount++;

        console.log(
          `[cron:api-key-reset] 已重置 Key "${key.name}" (${key.id.slice(0, 8)}...) ` +
            `resetPeriod=${key.resetPeriod} usedTokens=${key.usedTokens}→0`
        );
      } catch (err) {
        console.error(
          `[cron:api-key-reset] 重置单个 Key 失败 (${key.id}):`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    if (resetCount > 0) {
      console.log(
        `[cron:api-key-reset] 本轮重置了 ${resetCount} 个 API Key 的用量`
      );
    } else {
      console.log("[cron:api-key-reset] 无需重置的 API Key");
    }
  } catch (err) {
    console.error(
      "[cron:api-key-reset] 重置异常:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

// ==================== 平台模型自动发现 ====================

/**
 * 拉取所有启用平台的模型列表，更新到 platform_models 表
 *
 * 策略：
 * - 使用 Promise.allSettled 并发拉取所有平台
 * - 拉取失败时保留旧数据（不删除旧模型）
 * - 拉取成功时先删除旧模型再批量插入新模型
 * - 使用 detectModelType 自动分类模型类型
 */
async function runModelFetcher(env: Env): Promise<void> {
  const db = createDb(env.DB);
  const now = new Date().toISOString();

  try {
    // 查询所有已启用的平台
    const enabledPlatforms = await db
      .select({
        id: platforms.id,
        name: platforms.name,
        baseUrl: platforms.baseUrl,
        apiKey: platforms.apiKey,
        apiKeys: platforms.apiKeys,
      })
      .from(platforms)
      .where(eq(platforms.enabled, true));

    if (enabledPlatforms.length === 0) {
      console.log("[cron:model-fetcher] 没有已启用的平台");
      return;
    }

    let totalModels = 0;
    let successCount = 0;

    // 并发拉取所有平台
    const results = await Promise.allSettled(
      enabledPlatforms.map(async (platform) => {
        // 构建请求 URL
        const url = `${platform.baseUrl.replace(/\/+$/, "")}/models`;

        // 获取认证密钥（优先主密钥，其次附加密钥）
        let apiKey = platform.apiKey;
        if (!apiKey) {
          const extraKeys = parseApiKeys(platform.apiKeys);
          apiKey = extraKeys[0] ?? "";
        }
        if (!apiKey) {
          console.warn(
            `[cron:model-fetcher] 平台 ${platform.name} 没有可用的 API Key，跳过`
          );
          return;
        }

        try {
          // 发起请求获取模型列表
          const controller = new AbortController();
          const timeoutId = setTimeout(
            () => controller.abort(),
            FETCH_TIMEOUT_MS
          );

          const res = await fetch(url, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: controller.signal,
          });
          clearTimeout(timeoutId);

          if (!res.ok) {
            const errorText = await res.text().catch(() => "unknown");
            console.warn(
              `[cron:model-fetcher] 平台 ${platform.name} 拉取模型失败: HTTP ${res.status} - ${errorText}`
            );
            return;
          }

          const data = (await res.json()) as Record<string, unknown>;

          // 解析模型列表（兼容数组格式和 { data: [...] } 格式）
          const list: unknown[] = Array.isArray(data)
            ? data
            : Array.isArray((data as Record<string, unknown>).data)
              ? ((data as Record<string, unknown>).data as unknown[])
              : [];
          if (!Array.isArray(list)) {
            console.warn(
              `[cron:model-fetcher] 平台 ${platform.name} 返回数据格式不正确`
            );
            return;
          }

          // 过滤有效模型
          const models = list
            .filter(
              (item): item is { id: string; owned_by?: string } =>
                typeof item === "object" &&
                item !== null &&
                "id" in item &&
                typeof (item as Record<string, unknown>).id === "string"
            )
            .map((m) => ({
              id: m.id,
              owned_by: m.owned_by,
            }));

          // 删除旧模型，批量插入新模型
          try {
            await db
              .delete(platformModels)
              .where(eq(platformModels.platformId, platform.id));

            if (models.length > 0) {
              await db.insert(platformModels).values(
                models.map((m) => ({
                  id: crypto.randomUUID(),
                  platformId: platform.id,
                  modelId: m.id,
                  ownedBy: m.owned_by ?? platform.name,
                  type: detectModelType(m.id),
                  source: "auto",
                  fetchedAt: now,
                }))
              );
            }

            totalModels += models.length;
            successCount++;
          } catch (dbErr) {
            console.warn(
              `[cron:model-fetcher] 平台 ${platform.name} 数据库写入失败，保留旧数据:`,
              dbErr instanceof Error ? dbErr.message : String(dbErr)
            );
          }
        } catch (fetchErr) {
          console.warn(
            `[cron:model-fetcher] 平台 ${platform.name} 网络请求失败，保留旧数据:`,
            fetchErr instanceof Error ? fetchErr.message : String(fetchErr)
          );
        }
      })
    );

    // 统计失败数
    const failCount = results.filter((r) => r.status === "rejected").length;
    if (failCount > 0) {
      console.warn(
        `[cron:model-fetcher] ${failCount} 个平台拉取过程异常`
      );
    }

    console.log(
      `[cron:model-fetcher] 拉取完成: ${successCount}/${enabledPlatforms.length} 个平台, ${totalModels} 个模型`
    );
  } catch (err) {
    console.error(
      "[cron:model-fetcher] 拉取异常:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

// ==================== 日志归档 ====================

/**
 * 执行日志归档任务
 *
 * 查询超过 RETENTION_DAYS 天的 requestLogs，按 keyId + model 分组聚合，
 * 写入 daily_stats 表后删除原始详细记录。
 * 同时清理 auditLogs（90 天）和 systemEvents（7 天）中的过期数据。
 */
async function runLogArchiver(env: Env): Promise<void> {
  const db = createDb(env.DB);
  const now = new Date().toISOString();

  try {
    // 计算截止日期（保留期前的最后一天）
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);
    cutoffDate.setHours(23, 59, 59, 999);
    const cutoffStr = cutoffDate.toISOString();

    // 查询最早的 requestLog 时间
    const oldestResult = await db
      .select({ createdAt: requestLogs.createdAt })
      .from(requestLogs)
      .orderBy(requestLogs.createdAt)
      .limit(1);

    if (oldestResult.length === 0) {
      console.log("[cron:log-archiver] 没有需要归档的日志");
      return;
    }

    const oldestLog = oldestResult[0];

    // 如果最早日志也在保留期内，无需归档
    const retentionStart = new Date();
    retentionStart.setDate(retentionStart.getDate() - RETENTION_DAYS);
    retentionStart.setHours(0, 0, 0, 0);

    if (new Date(oldestLog.createdAt) >= retentionStart) {
      console.log("[cron:log-archiver] 所有日志均在保留期内，无需归档");

      // 即使无需归档 requestLogs，也清理其他过期数据
      await cleanupExpiredLogs(db);
      return;
    }

    console.log(
      `[cron:log-archiver] 开始归档，截止日期: ${cutoffStr.slice(0, 10)}，最早日志: ${oldestLog.createdAt.slice(0, 10)}`
    );

    // 按批次处理（每批 BATCH_SIZE 天）
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

      const result = await archiveLogsInBatch(
        db,
        new Date(batchStart),
        new Date(batchEnd)
      );
      totalDatesArchived += result.datesArchived;
      totalLogsProcessed += result.logsProcessed;
      totalLogsDeleted += result.logsDeleted;

      batchStart.setDate(batchStart.getDate() + BATCH_SIZE);
    }

    // 清理其他过期日志（auditLogs 90 天、systemEvents 7 天）
    await cleanupExpiredLogs(db);

    // 记录归档事件
    await db
      .insert(systemEvents)
      .values({
        id: crypto.randomUUID(),
        level: "info",
        message: "日志归档任务完成",
        detail: JSON.stringify({
          retentionDays: RETENTION_DAYS,
          datesArchived: totalDatesArchived,
          logsProcessed: totalLogsProcessed,
          logsDeleted: totalLogsDeleted,
          executedAt: now,
        }),
        createdAt: now,
      })
      .catch((err) => {
        console.error(
          "[cron:log-archiver] 记录归档事件失败:",
          err instanceof Error ? err.message : String(err)
        );
      });

    console.log(
      `[cron:log-archiver] 归档完成: ${totalDatesArchived} 天, ${totalLogsProcessed} 条日志处理, ${totalLogsDeleted} 条已删除`
    );
  } catch (err) {
    console.error(
      "[cron:log-archiver] 归档异常:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * 清理过期的 auditLogs 和 systemEvents
 *
 * auditLogs 保留 90 天，systemEvents 保留 7 天。
 * 与日志归档任务合并执行。
 */
async function cleanupExpiredLogs(
  db: ReturnType<typeof createDb>
): Promise<void> {
  try {
    const auditLogsCutoff = new Date(
      Date.now() - 90 * 24 * 60 * 60 * 1000
    ).toISOString();
    const systemEventsCutoff = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000
    ).toISOString();

    await db
      .delete(auditLogs)
      .where(lte(auditLogs.createdAt, auditLogsCutoff));

    await db
      .delete(systemEvents)
      .where(lte(systemEvents.createdAt, systemEventsCutoff));
  } catch (err) {
    console.error(
      "[cron:log-archiver] 清理过期日志失败:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * 批量归档指定日期范围内的请求日志
 *
 * 按天遍历日期范围，对每天的日志按 keyId + model 分组聚合，
 * 写入 dailyStats 表后删除原始日志。
 *
 * @returns 归档的日期数、处理的日志条数、删除的日志条数
 */
async function archiveLogsInBatch(
  db: ReturnType<typeof createDb>,
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
      const result = await archiveSingleDay(db, dayStart, dayEnd);
      totalLogsProcessed += result.processed;
      totalLogsDeleted += result.deleted;
      if (result.processed > 0) {
        datesArchived++;
      }
    } catch (err) {
      console.error(
        `[cron:log-archiver] 归档日期 ${dayStart.toISOString().slice(0, 10)} 失败:`,
        err instanceof Error ? err.message : String(err)
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
 *
 * 查询指定日期的所有 requestLogs，按 keyId + model 分组聚合，
 * 写入 dailyStats 表后删除原始日志。
 */
async function archiveSingleDay(
  db: ReturnType<typeof createDb>,
  dayStart: Date,
  dayEnd: Date
): Promise<{ processed: number; deleted: number }> {
  const dayStartStr = dayStart.toISOString();
  const dayEndStr = dayEnd.toISOString();
  const dateOnly = dayStart.toISOString().split("T")[0];

  // 查询该天所有日志
  const logs = await db
    .select({
      keyId: requestLogs.keyId,
      platformId: requestLogs.platformId,
      model: requestLogs.model,
      tokens: requestLogs.tokens,
      promptTokens: requestLogs.promptTokens,
      completionTokens: requestLogs.completionTokens,
      ttft: requestLogs.ttft,
      duration: requestLogs.duration,
      isError: requestLogs.isError,
    })
    .from(requestLogs)
    .where(
      and(
        gte(requestLogs.createdAt, dayStartStr),
        lte(requestLogs.createdAt, dayEndStr)
      )
    );

  if (logs.length === 0) return { processed: 0, deleted: 0 };

  // 按 keyId + model 分组聚合
  type GroupData = {
    keyId: string | null;
    platformId: string | null;
    model: string;
    totalRequests: number;
    errorRequests: number;
    totalTokens: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    ttftSum: number;
    ttftCount: number;
    durationSum: number;
    durationCount: number;
    maxTtft: number;
    maxDuration: number;
  };

  const groups = new Map<string, GroupData>();

  for (const log of logs) {
    const groupKey = `${log.keyId || "null"}|||${log.model}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        keyId: log.keyId,
        platformId: log.platformId,
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
    group.totalTokens += log.tokens ?? 0;
    group.totalPromptTokens += log.promptTokens ?? 0;
    group.totalCompletionTokens += log.completionTokens ?? 0;
    if ((log.ttft ?? 0) > 0) {
      group.ttftSum += log.ttft!;
      group.ttftCount++;
    }
    if ((log.duration ?? 0) > 0) {
      group.durationSum += log.duration!;
      group.durationCount++;
    }
    if ((log.ttft ?? 0) > group.maxTtft) group.maxTtft = log.ttft!;
    if ((log.duration ?? 0) > group.maxDuration) group.maxDuration = log.duration!;
  }

  // 写入 dailyStats（按 keyId + model 合并）
  for (const group of groups.values()) {
    const avgTtft =
      group.ttftCount > 0 ? group.ttftSum / group.ttftCount : 0;
    const avgDuration =
      group.durationCount > 0
        ? group.durationSum / group.durationCount
        : 0;

    // 查询是否已有该维度的聚合记录
    const existingRows = await db
      .select({ id: dailyStats.id })
      .from(dailyStats)
      .where(
        and(
          eq(dailyStats.date, dateOnly),
          group.keyId !== null
            ? eq(dailyStats.keyId, group.keyId)
            : sql`${dailyStats.keyId} IS NULL`,
          eq(dailyStats.model, group.model)
        )
      )
      .limit(1);

    if (existingRows.length > 0) {
      // 更新已有记录：累加计数，重新计算平均值
      const existing = existingRows[0];
      await db
        .update(dailyStats)
        .set({
          totalRequests: sql`${dailyStats.totalRequests} + ${group.totalRequests}`,
          errorRequests: sql`${dailyStats.errorRequests} + ${group.errorRequests}`,
          totalTokens: sql`${dailyStats.totalTokens} + ${group.totalTokens}`,
          totalPromptTokens: sql`${dailyStats.totalPromptTokens} + ${group.totalPromptTokens}`,
          totalCompletionTokens: sql`${dailyStats.totalCompletionTokens} + ${group.totalCompletionTokens}`,
          avgTtft: sql`(${dailyStats.avgTtft} * ${dailyStats.totalRequests} + ${avgTtft} * ${group.totalRequests}) / (${dailyStats.totalRequests} + ${group.totalRequests})`,
          avgDuration: sql`(${dailyStats.avgDuration} * ${dailyStats.totalRequests} + ${avgDuration} * ${group.totalRequests}) / (${dailyStats.totalRequests} + ${group.totalRequests})`,
          maxTtft: sql`max(${dailyStats.maxTtft}, ${group.maxTtft})`,
          maxDuration: sql`max(${dailyStats.maxDuration}, ${group.maxDuration})`,
        })
        .where(eq(dailyStats.id, existing.id));
    } else {
      // 插入新记录
      await db.insert(dailyStats).values({
        id: crypto.randomUUID(),
        date: dateOnly,
        keyId: group.keyId,
        keyName: null,
        platformId: group.platformId,
        platformName: null,
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
      });
    }
  }

  // 删除该天的原始日志
  const deleteResult = await db
    .delete(requestLogs)
    .where(
      and(
        gte(requestLogs.createdAt, dayStartStr),
        lte(requestLogs.createdAt, dayEndStr)
      )
    );

  return {
    processed: logs.length,
    deleted: deleteResult.meta?.changes ?? logs.length,
  };
}
