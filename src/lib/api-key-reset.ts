/**
 * API Key 用量自动重置调度器
 *
 * 根据 ApiKey.resetPeriod 字段定期重置 usedTokens：
 * - monthly：每月第一天重置
 * - daily：每天凌晨重置
 * - never：不重置
 *
 * 重置判断基于 updatedAt 字段：
 * - 如果上次更新日期与当前日期不在同一周期，则执行重置
 * - 重置时同时将 status 恢复为 active（防止因超限被禁用的 Key 在新周期仍被禁用）
 *
 * 在首次调用时初始化，后续按固定间隔执行。
 * 可安全多次调用，仅首次生效。
 */

import { prisma } from "./prisma";

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 每小时检查一次

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * 判断指定 API Key 是否需要在当前周期重置
 *
 * 使用 updatedAt 字段判断：如果上次更新日期与当前日期不在同一周期，则需要重置。
 * 这样即使服务重启，也不会重复重置（因为重置后 updatedAt 会更新到当前时间）。
 */
function needsReset(apiKey: { resetPeriod: string | null; updatedAt: Date }): boolean {
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
 * 执行一轮重置检查
 *
 * 查询所有 resetPeriod !== "never" 且 status 为 active 的 API Key，
 * 逐个检查是否需要重置。重置操作包括：
 * 1. usedTokens 归零
 * 2. status 恢复为 active（防止超限禁用在新周期仍生效）
 * 3. updatedAt 更新（防止同一周期内重复重置）
 */
async function runReset() {
  try {
    const keysToCheck = await prisma.apiKey.findMany({
      where: {
        resetPeriod: { not: "never" },
      },
      select: {
        id: true,
        name: true,
        resetPeriod: true,
        usedTokens: true,
        status: true,
        updatedAt: true,
      },
    });

    let resetCount = 0;

    for (const key of keysToCheck) {
      if (!needsReset(key)) continue;

      // 执行重置：归零 usedTokens，恢复 status 为 active
      await prisma.apiKey.update({
        where: { id: key.id },
        data: {
          usedTokens: BigInt(0),
          // 如果因超限被禁用，在新周期自动恢复
          ...(key.status === "disabled" ? { status: "active" } : {}),
        },
      });

      resetCount++;

      if (process.env.NODE_ENV !== "production") {
        console.log(
          `[api-key-reset] 已重置 Key "${key.name}" (${key.id.slice(0, 8)}...) ` +
          `resetPeriod=${key.resetPeriod} usedTokens=${key.usedTokens}→0`
        );
      }
    }

    if (resetCount > 0) {
      console.log(`[api-key-reset] 本轮重置了 ${resetCount} 个 API Key 的用量`);
    }
  } catch (err) {
    console.error(
      "[api-key-reset] 重置异常:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * 启动 API Key 用量重置调度器
 *
 * 在首次调用时初始化，后续按固定间隔执行。
 * 可安全多次调用，仅首次生效。
 */
export function startApiKeyResetScheduler() {
  if (timer) return;
  console.log("[api-key-reset] 启动 API Key 用量重置调度器，间隔 1 小时");
  // 首次延迟 60 秒执行，等待系统启动完成
  setTimeout(runReset, 60_000);
  timer = setInterval(runReset, CHECK_INTERVAL_MS);
}

/**
 * 停止 API Key 用量重置调度器
 */
export function stopApiKeyResetScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
