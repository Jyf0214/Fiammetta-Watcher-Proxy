/**
 * 负载均衡 + 熔断器
 *
 * 为平台选择提供：
 * - 平台状态检查（healthy / degraded / down）
 * - 熔断器状态管理（closed / open / half-open）
 * - 成功/失败记录触发状态转换
 * - 权重轮询选择平台
 */

import { eq } from "drizzle-orm";
import { createDb } from "@/lib/db";
import * as schema from "@/lib/schema";
import type { PlatformConfig, CircuitBreakerState } from "@/lib/types";

// ==================== 熔断器状态机 ====================

interface CircuitBreakerEntry {
  state: CircuitBreakerState;
  failureCount: number;
  lastFailureAt: number;
  cooldownEnd: number;
  halfOpenAttempts: number;
  halfOpenPending: number;
}

const breakers = new Map<string, CircuitBreakerEntry>();

/** 熔断器默认配置 */
const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_HALF_OPEN_MAX = 3;

/**
 * 获取平台熔断器状态（纯查询，无副作用）
 */
export function getCircuitBreakerState(platformId: string): CircuitBreakerState {
  const entry = breakers.get(platformId);
  if (!entry) return "closed";
  return entry.state;
}

/**
 * 检查并更新平台熔断器状态（具有副作用：open → half-open 转换）
 */
export function checkAndUpdateCircuitBreakerState(
  platformId: string
): CircuitBreakerState {
  const entry = breakers.get(platformId);
  if (!entry) return "closed";

  if (entry.state === "open") {
    if (Date.now() >= entry.cooldownEnd) {
      entry.state = "half-open";
      entry.halfOpenAttempts = 0;
      return "half-open";
    }
    return "open";
  }

  if (entry.state === "half-open") {
    if (entry.halfOpenPending >= DEFAULT_HALF_OPEN_MAX) {
      return "open";
    }
    return "half-open";
  }

  return entry.state;
}

/**
 * 递增半开状态下的并发探测计数
 */
export function incrementHalfOpenPending(platformId: string): void {
  const entry = breakers.get(platformId);
  if (entry && entry.state === "half-open") {
    entry.halfOpenPending++;
  }
}

/**
 * 记录请求成功 — 更新熔断器状态
 *
 * 成功时：
 * - closed → 保持 closed，清零失败计数
 * - half-open → 转为 closed（恢复）
 */
export async function recordSuccess(platformId: string): Promise<void> {
  const entry = breakers.get(platformId);
  if (!entry) return;

  if (entry.state === "half-open") {
    // 半开状态成功 → 恢复为 closed
    entry.state = "closed";
    entry.failureCount = 0;
    entry.halfOpenAttempts = 0;
    entry.halfOpenPending = 0;
    console.log(`[circuit-breaker] 平台 ${platformId} 恢复为 closed`);

    // 更新数据库状态
    await updatePlatformStatus(platformId, "healthy", 0, null);
  } else if (entry.state === "closed") {
    // closed 状态成功 → 清零失败计数
    if (entry.failureCount > 0) {
      entry.failureCount = 0;
    }
  }
}

/**
 * 记录请求失败 — 更新熔断器状态
 *
 * 失败时：
 * - closed → 失败计数递增，达到阈值则熔断（open）
 * - half-open → 失败则回到 open
 */
export async function recordFailure(platformId: string): Promise<void> {
  const now = Date.now();
  let entry = breakers.get(platformId);

  if (!entry) {
    entry = {
      state: "closed",
      failureCount: 1,
      lastFailureAt: now,
      cooldownEnd: 0,
      halfOpenAttempts: 0,
      halfOpenPending: 0,
    };
    breakers.set(platformId, entry);
    return;
  }

  entry.failureCount++;
  entry.lastFailureAt = now;

  if (entry.state === "half-open") {
    // 半开状态失败 → 回到 open
    entry.state = "open";
    entry.cooldownEnd = now + DEFAULT_COOLDOWN_MS;
    entry.halfOpenAttempts = 0;
    entry.halfOpenPending = 0;
    console.log(
      `[circuit-breaker] 平台 ${platformId} 半开状态失败，回到 open，冷却至 ${new Date(entry.cooldownEnd).toISOString()}`
    );

    await updatePlatformStatus(platformId, "down", entry.failureCount, entry.cooldownEnd);
  } else if (
    entry.state === "closed" &&
    entry.failureCount >= DEFAULT_FAILURE_THRESHOLD
  ) {
    // closed 状态达到失败阈值 → 熔断
    entry.state = "open";
    entry.cooldownEnd = now + DEFAULT_COOLDOWN_MS;
    console.log(
      `[circuit-breaker] 平台 ${platformId} 连续失败 ${entry.failureCount} 次，熔断至 ${new Date(entry.cooldownEnd).toISOString()}`
    );

    await updatePlatformStatus(platformId, "down", entry.failureCount, entry.cooldownEnd);
  }
}

/**
 * 更新平台状态到数据库
 */
async function updatePlatformStatus(
  platformId: string,
  status: string,
  failCount: number,
  cooldownEnd: number | null
): Promise<void> {
  try {
    // 这里需要通过 Worker 的 Env.DB 来更新，但 load-balancer 不直接持有 DB
    // 通过全局 env 引用或参数传入
    // 暂时使用 console 记录，实际状态由 router 通过 API 更新
    console.log(
      `[circuit-breaker] 平台 ${platformId} 状态更新: status=${status} failCount=${failCount}`
    );
  } catch (err) {
    console.error(
      `[circuit-breaker] 更新平台状态失败:`,
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * 启动时从数据库同步熔断器状态
 */
export async function syncCircuitBreakersFromDatabase(db: D1Database): Promise<void> {
  try {
    const orm = await createDb(db);
    const platforms = await orm
      .select({
        id: schema.platforms.id,
        status: schema.platforms.status,
        failCount: schema.platforms.failCount,
        cooldownEnd: schema.platforms.cooldownEnd,
      })
      .from(schema.platforms);

    const now = Date.now();
    let syncedCount = 0;

    for (const p of platforms) {
      if (p.status === "down") {
        const cooldownMs = p.cooldownEnd ?? 0;
        const isExpired = cooldownMs <= now;

        breakers.set(p.id, {
          state: isExpired ? "half-open" : "open",
          failureCount: p.failCount,
          lastFailureAt: 0,
          cooldownEnd: cooldownMs,
          halfOpenAttempts: 0,
          halfOpenPending: 0,
        });
        syncedCount++;
      } else if (p.status === "degraded") {
        breakers.set(p.id, {
          state: "closed",
          failureCount: p.failCount,
          lastFailureAt: 0,
          cooldownEnd: 0,
          halfOpenAttempts: 0,
          halfOpenPending: 0,
        });
        syncedCount++;
      }
    }

    if (syncedCount > 0) {
      console.log(`[circuit-breaker] 从数据库同步了 ${syncedCount} 个平台的熔断器状态`);
    }
  } catch (err) {
    console.error(
      "[circuit-breaker] 从数据库同步状态失败:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * 清理已删除平台的断路器条目
 */
export function cleanupStaleBreakers(activePlatformIds: string[]): void {
  const activeSet = new Set(activePlatformIds);
  for (const [platformId] of breakers) {
    if (!activeSet.has(platformId)) {
      breakers.delete(platformId);
    }
  }
}

/**
 * 选择下一个平台（带权重轮询）
 *
 * 从启用的平台列表中，根据优先级和权重选择一个平台。
 * 同时考虑熔断器状态，跳过 open 状态的平台。
 */
export function selectPlatform(
  platforms: PlatformConfig[]
): PlatformConfig | null {
  const now = Date.now();

  // 过滤可用平台
  const available = platforms.filter((p) => {
    if (!p.enabled) return false;

    const breakerState = checkAndUpdateCircuitBreakerState(p.id);
    if (breakerState === "open") return false;
    if (breakerState === "half-open") {
      // 半开状态限制并发探测
      incrementHalfOpenPending(p.id);
    }

    // 检查冷却期
    if (p.cooldownEnd !== null && p.cooldownEnd > now) return false;

    return true;
  });

  if (available.length === 0) return null;

  // 按优先级分组
  const maxPriority = Math.max(...available.map((p) => p.priority));
  const topPriority = available.filter((p) => p.priority === maxPriority);

  // 权重轮询
  const totalWeight = topPriority.reduce((sum, p) => sum + p.weight, 0);
  if (totalWeight <= 0) return topPriority[0] ?? null;

  let random = Math.random() * totalWeight;
  for (const p of topPriority) {
    random -= p.weight;
    if (random <= 0) return p;
  }

  return topPriority[topPriority.length - 1] ?? null;
}
