/**
 * 熔断器状态管理
 *
 * 使用 KV 存储状态（替代内存 Map），支持 Cloudflare Workers 分布式运行。
 * KV key 前缀 "cb:"，不过期（依赖 D1 作为持久化源）。
 * 启动时通过 syncFromDatabase 从 D1 恢复状态到 KV。
 *
 * 三态模型：closed → open → half-open → closed
 * - closed：正常状态，请求正常通过
 * - open：熔断状态，拒绝所有请求，冷却期后转为 half-open
 * - half-open：探测状态，允许少量请求探测上游是否恢复
 *
 * 与原版差异：
 * - KV 替代内存 Map，解决 Worker 重启状态丢失问题
 * - 启动时从 D1 同步状态到 KV，确保 Worker 重启后状态不丢失
 * - open → half-open 转换有竞态保护，防止并发请求重复触发
 * - 状态变更后自动刷新路由缓存，确保路由决策使用最新状态
 * - DB 更新通过 Drizzle ORM（D1 SQLite）
 * - 移除 notifier 依赖（通知功能由 cron 任务或 admin 路由处理）
 */

import type { KVNamespace, D1Database } from "@cloudflare/workers-types";
import type { Env } from "../types";
import { createDb } from "../db";
import { platforms } from "../db/schema";
import { eq, or } from "drizzle-orm";

// ==================== 熔断器类型 ====================
// Worker 版本中类型定义在本模块内，避免修改 types.ts

/** 熔断器状态 */
export type CircuitBreakerState = "closed" | "open" | "half-open";

/** 熔断器配置 */
export interface CircuitBreakerConfig {
  failureThreshold: number; // 触发熔断的连续失败次数
  cooldownMs: number; // 熔断冷却时间（毫秒）
  halfOpenMaxAttempts: number; // 半开状态最大尝试次数
}

/** KV 中存储的熔断器条目 */
interface CircuitBreakerEntry {
  state: CircuitBreakerState;
  failureCount: number;
  lastFailureAt: number;
  cooldownEnd: number;
  halfOpenAttempts: number;
  halfOpenPending: number;
}

/** KV key 前缀 */
const CB_KEY_PREFIX = "cb:";

/** 默认熔断器配置 */
const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  cooldownMs: 60_000,
  halfOpenMaxAttempts: 3,
};

/**
 * 从 KV 读取熔断器条目
 */
async function getEntry(kv: KVNamespace, platformId: string): Promise<CircuitBreakerEntry | null> {
  const raw = await kv.get(`${CB_KEY_PREFIX}${platformId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CircuitBreakerEntry;
  } catch {
    return null;
  }
}

/**
 * 将熔断器条目写入 KV（不过期，依赖 D1 作为持久化源）
 */
async function saveEntry(kv: KVNamespace, platformId: string, entry: CircuitBreakerEntry): Promise<void> {
  await kv.put(
    `${CB_KEY_PREFIX}${platformId}`,
    JSON.stringify(entry)
  );
}

/**
 * 纯查询：获取平台熔断器状态（不修改任何状态）
 *
 * 用于展示、统计等不需要触发状态转换的场景。
 * 与 checkAndUpdateCircuitBreakerState 的区别：不执行 open → half-open 转换。
 */
export async function getCircuitBreakerState(
  env: { KV: KVNamespace },
  platformId: string
): Promise<CircuitBreakerState> {
  const entry = await getEntry(env.KV, platformId);
  if (!entry) return "closed";
  return entry.state;
}

// ==================== 竞态保护 ====================
// open → half-open 转换需要加锁，防止并发请求重复触发探测

const pendingTransitions = new Map<string, Promise<void>>();

/**
 * 对指定平台的 open → half-open 转换加锁
 *
 * 在 Cloudflare Workers 中，多个并发请求可能同时读到 open 状态
 * 且冷却期已过，导致重复触发 half-open 探测。此锁确保同一平台
 * 同时只有一个请求执行转换。
 */
async function withTransitionLock<T>(platformId: string, fn: () => Promise<T>): Promise<T> {
  const prev = pendingTransitions.get(platformId);
  if (prev) {
    try { await prev; } catch { /* 忽略前序锁错误 */ }
  }

  let release!: () => void;
  const lock = new Promise<void>((resolve) => { release = resolve; });
  pendingTransitions.set(platformId, lock);

  try {
    return await fn();
  } finally {
    pendingTransitions.delete(platformId);
    release();
  }
}

// ==================== 启动时 DB 状态同步 ====================

/** 是否已执行过启动同步 */
let synced = false;

/**
 * 从 D1 同步熔断器状态到 KV（Worker 重启后首次路由时调用）
 *
 * Worker 重启后 KV 内存缓存可能丢失，此函数从 D1 的 platforms 表
 * 读取非健康状态的平台，恢复其熔断器状态到 KV。
 * 仅执行一次，后续请求不再重复同步。
 */
export async function syncFromDatabase(env: { KV: KVNamespace; DB: D1Database }): Promise<void> {
  if (synced) return;
  synced = true;

  try {
    const db = createDb(env.DB);
    const platformRows = await db.select().from(platforms)
      .where(or(eq(platforms.status, "down"), eq(platforms.status, "degraded")));
    const now = Date.now();
    for (const p of platformRows) {
      if (p.status === "down") {
        const cooldownMs = p.cooldownEnd ? new Date(p.cooldownEnd).getTime() : 0;
        await env.KV.put(`${CB_KEY_PREFIX}${p.id}`, JSON.stringify({
          state: cooldownMs <= now ? "half-open" : "open",
          failureCount: p.failCount,
          cooldownEnd: cooldownMs,
          halfOpenAttempts: 0,
          halfOpenPending: 0,
        }), { expirationTtl: 3600 });
        console.log(
          `[circuit-breaker] 从 DB 恢复平台 ${p.id} 状态: ${cooldownMs <= now ? "half-open" : "open"}`
        );
      } else if (p.status === "degraded") {
        await env.KV.put(`${CB_KEY_PREFIX}${p.id}`, JSON.stringify({
          state: "closed",
          failureCount: p.failCount,
          cooldownEnd: 0,
          halfOpenAttempts: 0,
          halfOpenPending: 0,
        }), { expirationTtl: 3600 });
        console.log(
          `[circuit-breaker] 从 DB 恢复平台 ${p.id} 状态: closed (degraded)`
        );
      }
    }
  } catch (err) {
    console.error("[circuit-breaker] 从数据库同步熔断器状态失败:", err);
    // 同步失败不阻止请求处理，仅记录错误
  }
}

/**
 * 通知路由模块刷新缓存（延迟导入避免循环依赖）
 *
 * 熔断器状态变更后调用，确保路由决策使用最新状态。
 * 使用延迟导入避免 circuit-breaker → router → circuit-breaker 循环依赖。
 */
async function notifyRouteCacheRefresh(env: { KV: KVNamespace; DB: D1Database }): Promise<void> {
  try {
    const router = await import("./router");
    await router.forceRefreshRouterCache(env as Env);
  } catch (err) {
    console.error("[circuit-breaker] 路由缓存刷新失败:", err);
  }
}

/**
 * 检查并更新平台熔断器状态（具有副作用）
 *
 * 注意：此函数具有副作用——当熔断器处于 open 状态且冷却期已过时，
 * 会将状态转换为 half-open 并重置 halfOpenAttempts。
 * open → half-open 转换有竞态保护，防止并发请求重复触发。
 *
 * 仅在实际路由决策路径中使用；展示/统计场景请用 getCircuitBreakerState。
 */
export async function checkAndUpdateCircuitBreakerState(
  env: { KV: KVNamespace },
  platformId: string
): Promise<CircuitBreakerState> {
  const entry = await getEntry(env.KV, platformId);
  if (!entry) return "closed";

  if (entry.state === "open") {
    if (Date.now() >= entry.cooldownEnd) {
      // open → half-open 转换需要加锁，防止并发竞态
      return await withTransitionLock(platformId, async () => {
        // 重新读取，因为等待锁期间状态可能已变更
        const latestEntry = await getEntry(env.KV, platformId);
        if (!latestEntry || latestEntry.state !== "open") {
          return (latestEntry?.state ?? "closed") as CircuitBreakerState;
        }
        if (Date.now() >= latestEntry.cooldownEnd) {
          latestEntry.state = "half-open";
          latestEntry.halfOpenAttempts = 0;
          await saveEntry(env.KV, platformId, latestEntry);
          return "half-open" as const;
        }
        return "open" as const;
      });
    }
    return "open";
  }

  if (entry.state === "half-open") {
    // 限制并发探测请求数为 halfOpenMaxAttempts
    if (entry.halfOpenPending >= DEFAULT_CONFIG.halfOpenMaxAttempts) {
      return "open" as const;
    }
    return "half-open" as const;
  }

  return entry.state;
}

/**
 * 递增半开状态下的并发探测计数
 */
export async function incrementHalfOpenPending(
  env: { KV: KVNamespace },
  platformId: string
): Promise<void> {
  const entry = await getEntry(env.KV, platformId);
  if (entry && entry.state === "half-open") {
    entry.halfOpenPending += 1;
    await saveEntry(env.KV, platformId, entry);
  }
}

/**
 * 递减半开状态下的并发探测计数
 */
export async function decrementHalfOpenPending(
  env: { KV: KVNamespace },
  platformId: string
): Promise<void> {
  const entry = await getEntry(env.KV, platformId);
  if (entry && entry.halfOpenPending > 0) {
    entry.halfOpenPending -= 1;
    await saveEntry(env.KV, platformId, entry);
  }
}

/**
 * 记录请求成功
 *
 * half-open 状态下探测成功达到阈值后恢复为 closed，
 * 同时更新 DB 中的平台状态。
 */
export async function recordSuccess(
  env: { KV: KVNamespace; DB: D1Database },
  platformId: string
): Promise<void> {
  const entry = await getEntry(env.KV, platformId);

  if (entry?.state === "half-open") {
    entry.halfOpenAttempts += 1;
    if (entry.halfOpenPending > 0) entry.halfOpenPending -= 1;

    // 探测次数未达到上限，继续保持 half-open 状态
    if (entry.halfOpenAttempts < DEFAULT_CONFIG.halfOpenMaxAttempts) {
      await saveEntry(env.KV, platformId, entry);
      return;
    }

    // 探测次数达到上限且全部成功，恢复为 closed 状态
    entry.state = "closed";
    entry.failureCount = 0;
    entry.halfOpenAttempts = 0;
    entry.halfOpenPending = 0;
    await saveEntry(env.KV, platformId, entry);

    // 更新 DB
    try {
      const db = createDb(env.DB);
      await db.update(platforms)
        .set({ status: "healthy", failCount: 0, cooldownEnd: null })
        .where(eq(platforms.id, platformId));
    } catch (err) {
      console.error(
        `[circuit-breaker] 恢复健康状态时数据库更新失败 (platformId=${platformId}):`,
        err
      );
    }

    console.log(`[circuit-breaker] 平台 ${platformId} 已恢复正常状态`);

    // 刷新路由缓存，确保路由决策使用最新状态
    await notifyRouteCacheRefresh(env);
    return;
  }

  if (entry?.state === "closed" && entry.failureCount > 0) {
    entry.failureCount = 0;
    await saveEntry(env.KV, platformId, entry);

    try {
      const db = createDb(env.DB);
      await db.update(platforms)
        .set({ failCount: 0 })
        .where(eq(platforms.id, platformId));
    } catch (err) {
      console.error(
        `[circuit-breaker] 重置失败计数时数据库更新失败 (platformId=${platformId}):`,
        err
      );
    }

    // 刷新路由缓存，确保路由决策使用最新状态
    await notifyRouteCacheRefresh(env);
  }
}

/**
 * 记录请求失败
 *
 * - half-open 状态下失败：立即重新打开熔断器
 * - closed 状态下累积失败达到阈值：打开熔断器
 * - DB 同步更新平台状态
 */
export async function recordFailure(
  env: { KV: KVNamespace; DB: D1Database },
  platformId: string,
  config: CircuitBreakerConfig = DEFAULT_CONFIG
): Promise<void> {
  let entry = await getEntry(env.KV, platformId);
  if (!entry) {
    entry = {
      state: "closed",
      failureCount: 0,
      lastFailureAt: 0,
      cooldownEnd: 0,
      halfOpenAttempts: 0,
      halfOpenPending: 0,
    };
  }

  entry.failureCount += 1;
  entry.lastFailureAt = Date.now();

  if (entry.state === "half-open") {
    // half-open 状态下请求失败，立即重新打开熔断器并重置冷却时间
    if (entry.halfOpenPending > 0) entry.halfOpenPending -= 1;
    entry.state = "open";
    entry.cooldownEnd = Date.now() + config.cooldownMs;
    await saveEntry(env.KV, platformId, entry);

    // 更新 DB
    try {
      const db = createDb(env.DB);
      const now = new Date();
      const cooldownDate = new Date(entry.cooldownEnd);
      await db.update(platforms)
        .set({
          status: "down",
          failCount: entry.failureCount,
          lastFailAt: now.toISOString(),
          cooldownEnd: cooldownDate.toISOString(),
        })
        .where(eq(platforms.id, platformId));
    } catch (err) {
      console.error(
        `[circuit-breaker] half-open 状态失败后重新打开熔断器时数据库更新失败 (platformId=${platformId}):`,
        err
      );
    }

    console.warn(
      `[circuit-breaker] 平台 ${platformId} half-open 探测失败，熔断器重新打开`
    );

    // 刷新路由缓存，确保路由决策使用最新状态
    await notifyRouteCacheRefresh(env);
    return;
  }

  if (entry.failureCount >= config.failureThreshold) {
    entry.state = "open";
    entry.cooldownEnd = Date.now() + config.cooldownMs;
    await saveEntry(env.KV, platformId, entry);

    // 更新 DB
    try {
      const db = createDb(env.DB);
      const now = new Date();
      const cooldownDate = new Date(entry.cooldownEnd);
      await db.update(platforms)
        .set({
          status: "down",
          failCount: entry.failureCount,
          lastFailAt: now.toISOString(),
          cooldownEnd: cooldownDate.toISOString(),
        })
        .where(eq(platforms.id, platformId));
    } catch (err) {
      console.error(
        `[circuit-breaker] 熔断器打开时数据库更新失败 (platformId=${platformId}):`,
        err
      );
    }

    console.warn(
      `[circuit-breaker] 平台 ${platformId} 熔断器打开，连续失败 ${entry.failureCount} 次`
    );

    // 刷新路由缓存，确保路由决策使用最新状态
    await notifyRouteCacheRefresh(env);
    return;
  }

  // 未达阈值，仅更新 DB 状态
  await saveEntry(env.KV, platformId, entry);

  try {
    const db = createDb(env.DB);
    const now = new Date();
    await db.update(platforms)
      .set({
        status:
          entry.failureCount >= config.failureThreshold / 2
            ? "degraded"
            : "healthy",
        failCount: entry.failureCount,
        lastFailAt: now.toISOString(),
      })
      .where(eq(platforms.id, platformId));
  } catch (err) {
    console.error(
      `[circuit-breaker] 更新失败计数时数据库更新失败 (platformId=${platformId}):`,
      err
    );
  }
}

/**
 * 手动重置平台熔断器
 *
 * 删除 KV 中的熔断器条目，并重置 DB 中的平台状态。
 */
export async function resetCircuitBreaker(
  env: { KV: KVNamespace; DB: D1Database },
  platformId: string
): Promise<void> {
  await env.KV.delete(`${CB_KEY_PREFIX}${platformId}`);

  try {
    const db = createDb(env.DB);
    await db.update(platforms)
      .set({ status: "healthy", failCount: 0, cooldownEnd: null })
      .where(eq(platforms.id, platformId));
  } catch (err) {
    console.error(
      `[circuit-breaker] 手动重置时数据库更新失败 (platformId=${platformId}):`,
      err
    );
  }

  // 刷新路由缓存，确保路由决策使用最新状态
  await notifyRouteCacheRefresh(env);
}
