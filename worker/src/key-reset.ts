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
 * - 不修改 status：disabled 是管理员/系统的显式禁用状态，周期重置不得自动复活
 * - 重置时仅清理保留期外（已归档）的日志，保留期内明细供统计/趋势读取
 *
 * 入口：handleScheduledReset — Worker Cron Trigger 调用（批量重置所有 Key）
 */

import { createDb } from "@/lib/prisma";
import type { WorkerEnv } from "./config";

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
 *
 * daily：今天凌晨；monthly：本月 1 号凌晨；
 * never（及未知值）：返回 0——用量不按周期归零，auth.ts 的 callLimit 检查
 * 据此统计自创建起的全部请求（此前 fallback 到 monthly 窗口导致 never 的
 * 调用次数限制每月重置、形同虚设）
 */
export function getPeriodStart(resetPeriod: string): number {
  const now = new Date();
  if (resetPeriod === "daily") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.floor(start.getTime() / 1000);
  }
  if (resetPeriod === "monthly") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return Math.floor(start.getTime() / 1000);
  }
  // never / 未知值：不重置，窗口追溯到最早记录
  return 0;
}

/**
 * 执行一轮批量重置检查（Cron 调用）
 */
export async function handleScheduledReset(db: D1Database, env?: WorkerEnv): Promise<void> {
  const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
  try {
    const keysToCheck = await prisma.apiKeys.findMany({
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
    const currentTime = Math.floor(Date.now() / 1000);

    for (const key of keysToCheck) {
      if (!needsReset(key)) continue;

      await prisma.apiKeys.update({
        where: { id: key.id },
        data: {
          // Next.js SWC 构建 target 低于 ES2020 不支持 0n 字面量；number 写入
          // Prisma BigInt 字段自动转换，运行时读出仍为 bigint
          usedTokens: 0,
          updatedAt: currentTime,
        },
      });

      // 保留期外日志的删除由 log-archiver 全权负责（聚合进 daily_stats 后
      // 按 id 删除），此处不重复删除——archiver 未运行时直接删明细会造成
      // 统计空洞（既不留在 request_logs 也不进 daily_stats）
      resetCount++;
      console.log(
        `[key-reset] 已重置 Key "${key.name}" (${key.id.slice(0, 8)}...) ` +
          `resetPeriod=${key.resetPeriod} usedTokens=${key.usedTokens}→0`
      );
    }

    if (resetCount > 0) {
      console.log(`[key-reset] 本轮重置了 ${resetCount} 个 API Key 的用量`);
    }

    // ── 清理平台异常状态：cooldown 过期的平台恢复为 healthy ──
    const now = Math.floor(Date.now() / 1000);
    const abnormalPlatforms = await prisma.platforms.findMany({
      where: {
        status: { not: "healthy" },
      },
      select: {
        id: true,
        name: true,
        status: true,
        cooldownEnd: true,
      },
    });

    let restoredCount = 0;
    for (const p of abnormalPlatforms) {
      // cooldown 为空或已过期 → 恢复健康
      if (!p.cooldownEnd || p.cooldownEnd <= now) {
        await prisma.platforms.update({
          where: { id: p.id },
          data: {
            status: "healthy",
            failCount: 0,
            cooldownEnd: null,
            lastFailAt: null,
          },
        });
        restoredCount++;
        console.log(
          `[key-reset] 平台 "${p.name}" (${p.id.slice(0, 8)}...) 状态恢复为 healthy`
        );
      }
    }

    if (restoredCount > 0) {
      console.log(`[key-reset] 本轮恢复了 ${restoredCount} 个异常平台`);
    }
  } catch (err) {
    console.error(
      "[key-reset] 重置异常:",
      err instanceof Error ? err.message : String(err)
    );
  }
}
