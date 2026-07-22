/**
 * API Key 用量自动重置 — Worker Cron 版本
 *
 * 根据 api_keys.reset_period 字段定期重置 used_tokens：
 * - monthly：每月第一天重置
 * - daily：每天凌晨重置
 * - never：不重置
 *
 * 重置判断基于 updated_at 字段：
 * - 如果上次更新日期与当前日期不在同一周期，则执行重置
 * - 重置时同时将 status 恢复为 active（防止因超限被禁用的 Key 在新周期仍被禁用）
 *
 * 两个入口：
 * 1. handleScheduledReset — Worker Cron Trigger 调用（批量重置所有 Key）
 * 2. checkAndResetApiKey — 请求处理时调用（检查单个 Key）
 */

import { eq, and, lt, not } from "drizzle-orm";
import { createDb } from "@/lib/db";
import * as schema from "@/lib/schema";

/**
 * 判断指定 API Key 是否需要在当前周期重置
 */
function needsReset(key: {
  resetPeriod: string | null;
  updatedAt: number;
}): boolean {
  const now = new Date();
  const updated = new Date(key.updatedAt * 1000);

  switch (key.resetPeriod) {
    case "daily":
      return updated.toDateString() !== now.toDateString();
    case "monthly":
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
 * 计算当前周期的起始时间（Unix 时间戳，秒）
 */
export function getPeriodStart(resetPeriod: string): number {
  const now = new Date();
  if (resetPeriod === "daily") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.floor(start.getTime() / 1000);
  }
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return Math.floor(start.getTime() / 1000);
}

/**
 * 检查单个 API Key 是否需要重置，并在必要时执行重置
 */
export async function checkAndResetApiKey(
  db: D1Database,
  apiKeyId: string
): Promise<boolean> {
  try {
    const orm = createDb(db);
    const rows = await orm
      .select({
        id: schema.apiKeys.id,
        resetPeriod: schema.apiKeys.resetPeriod,
        usedTokens: schema.apiKeys.usedTokens,
        status: schema.apiKeys.status,
        updatedAt: schema.apiKeys.updatedAt,
      })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, apiKeyId))
      .limit(1);

    const apiKey = rows[0];
    if (!apiKey || !needsReset(apiKey)) {
      return false;
    }

    const periodStart = getPeriodStart(apiKey.resetPeriod!);
    const currentTime = Math.floor(Date.now() / 1000);

    await orm
      .update(schema.apiKeys)
      .set({
        usedTokens: 0,
        ...(apiKey.status === "disabled" ? { status: "active" } : {}),
        updatedAt: currentTime,
      })
      .where(eq(schema.apiKeys.id, apiKeyId));

    // 删除当前周期之前的请求日志
    await orm
      .delete(schema.requestLogs)
      .where(
        and(
          eq(schema.requestLogs.keyId, apiKeyId),
          lt(schema.requestLogs.createdAt, periodStart)
        )
      );

    console.log(
      `[key-reset] 请求时重置 Key ${apiKeyId.slice(0, 8)}... ` +
        `resetPeriod=${apiKey.resetPeriod} usedTokens=${apiKey.usedTokens}→0`
    );

    return true;
  } catch (error) {
    console.error(
      `[key-reset] 检查重置失败 (keyId=${apiKeyId}):`,
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
}

/**
 * 执行一轮批量重置检查（Cron 调用）
 */
export async function handleScheduledReset(db: D1Database): Promise<void> {
  try {
    const orm = createDb(db);
    const keysToCheck = await orm
      .select({
        id: schema.apiKeys.id,
        name: schema.apiKeys.name,
        resetPeriod: schema.apiKeys.resetPeriod,
        usedTokens: schema.apiKeys.usedTokens,
        status: schema.apiKeys.status,
        updatedAt: schema.apiKeys.updatedAt,
      })
      .from(schema.apiKeys)
      .where(not(eq(schema.apiKeys.resetPeriod, "never")));

    let resetCount = 0;
    const currentTime = Math.floor(Date.now() / 1000);

    for (const key of keysToCheck) {
      if (!needsReset(key)) continue;

      const periodStart = getPeriodStart(key.resetPeriod!);

      await orm
        .update(schema.apiKeys)
        .set({
          usedTokens: 0,
          ...(key.status === "disabled" ? { status: "active" } : {}),
          updatedAt: currentTime,
        })
        .where(eq(schema.apiKeys.id, key.id));

      await orm
        .delete(schema.requestLogs)
        .where(
          and(
            eq(schema.requestLogs.keyId, key.id),
            lt(schema.requestLogs.createdAt, periodStart)
          )
        );

      resetCount++;
      console.log(
        `[key-reset] 已重置 Key "${key.name}" (${key.id.slice(0, 8)}...) ` +
          `resetPeriod=${key.resetPeriod} usedTokens=${key.usedTokens}→0`
      );
    }

    if (resetCount > 0) {
      console.log(`[key-reset] 本轮重置了 ${resetCount} 个 API Key 的用量`);
    }
  } catch (err) {
    console.error(
      "[key-reset] 重置异常:",
      err instanceof Error ? err.message : String(err)
    );
  }
}
