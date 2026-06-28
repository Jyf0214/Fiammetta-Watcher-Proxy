import { prisma } from "./prisma";
import { forceRefreshRouterCache } from "./router";
import { notifyPlatformDown, notifyPlatformRecovered } from "./notifier";
import type { CircuitBreakerConfig, CircuitBreakerState } from "@/types";

// 内存存储的熔断器状态
interface CircuitBreakerEntry {
  state: CircuitBreakerState;
  failureCount: number;
  lastFailureAt: number;
  cooldownEnd: number;
  halfOpenAttempts: number;
  halfOpenPending: number;
}

const breakers = new Map<string, CircuitBreakerEntry>();

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  cooldownMs: 60_000,
  halfOpenMaxAttempts: 3,
};

/**
 * 检查并更新平台熔断器状态
 *
 * 注意：此函数具有副作用——当熔断器处于 open 状态且冷却期已过时，
 * 会将状态转换为 half-open 并重置 halfOpenAttempts。
 * 这是有意设计：调用者在查询状态的同时触发状态机的自然流转，
 * 避免在多处重复写转换逻辑。
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
export function incrementHalfOpenPending(platformId: string): void {
  const entry = breakers.get(platformId);
  if (entry && entry.state === "half-open") {
    entry.halfOpenPending += 1;
  }
}

/**
 * 递减半开状态下的并发探测计数
 */
export function decrementHalfOpenPending(platformId: string): void {
  const entry = breakers.get(platformId);
  if (entry && entry.halfOpenPending > 0) {
    entry.halfOpenPending -= 1;
  }
}

/**
 * 记录请求成功
 */
export async function recordSuccess(platformId: string): Promise<void> {
  const entry = breakers.get(platformId);

  if (entry?.state === "half-open") {
    entry.halfOpenAttempts += 1;
    decrementHalfOpenPending(platformId);

    // 探测次数未达到上限，继续保持 half-open 状态
    if (entry.halfOpenAttempts < DEFAULT_CONFIG.halfOpenMaxAttempts) {
      return;
    }

    // 探测次数达到上限且全部成功，恢复为 closed 状态
    entry.state = "closed";
    entry.failureCount = 0;
    entry.halfOpenAttempts = 0;

    try {
      await prisma.platform.update({
        where: { id: platformId },
        data: { status: "healthy", failCount: 0, cooldownEnd: null },
      });
    } catch (err) {
      console.error(
        `[circuit-breaker] 恢复健康状态时数据库更新失败 (platformId=${platformId}):`,
        err
      );
    }

    await forceRefreshRouterCache();
    await notifyPlatformRecovered(platformId);
    return;
  }

  if (entry?.state === "closed" && entry.failureCount > 0) {
    entry.failureCount = 0;

    try {
      await prisma.platform.update({
        where: { id: platformId },
        data: { failCount: 0 },
      });
    } catch (err) {
      console.error(
        `[circuit-breaker] 重置失败计数时数据库更新失败 (platformId=${platformId}):`,
        err
      );
    }
  }
}

/**
 * 记录请求失败
 */
export async function recordFailure(
  platformId: string,
  config: CircuitBreakerConfig = DEFAULT_CONFIG
): Promise<void> {
  let entry = breakers.get(platformId);
  if (!entry) {
    entry = {
      state: "closed",
      failureCount: 0,
      lastFailureAt: 0,
      cooldownEnd: 0,
      halfOpenAttempts: 0,
      halfOpenPending: 0,
    };
    breakers.set(platformId, entry);
  }

  entry.failureCount += 1;
  entry.lastFailureAt = Date.now();

  if (entry.state === "half-open") {
    // half-open 状态下请求失败，立即重新打开熔断器并重置冷却时间
    decrementHalfOpenPending(platformId);
    entry.state = "open";
    entry.cooldownEnd = Date.now() + config.cooldownMs;

    try {
      await prisma.platform.update({
        where: { id: platformId },
        data: {
          status: "down",
          failCount: entry.failureCount,
          lastFailAt: new Date(),
          cooldownEnd: new Date(entry.cooldownEnd),
        },
      });
    } catch (err) {
      console.error(
        `[circuit-breaker] half-open 状态失败后重新打开熔断器时数据库更新失败 (platformId=${platformId}):`,
        err
      );
    }

    await forceRefreshRouterCache();
    await notifyPlatformDown(platformId, entry.failureCount);
    return;
  }

  if (entry.failureCount >= config.failureThreshold) {
    entry.state = "open";
    entry.cooldownEnd = Date.now() + config.cooldownMs;

    try {
      await prisma.platform.update({
        where: { id: platformId },
        data: {
          status: "down",
          failCount: entry.failureCount,
          lastFailAt: new Date(),
          cooldownEnd: new Date(entry.cooldownEnd),
        },
      });
    } catch (err) {
      console.error(
        `[circuit-breaker] 熔断器打开时数据库更新失败 (platformId=${platformId}):`,
        err
      );
    }

    await forceRefreshRouterCache();
    await notifyPlatformDown(platformId, entry.failureCount);
    return;
  }

  try {
    await prisma.platform.update({
      where: { id: platformId },
      data: {
        status:
          entry.failureCount >= config.failureThreshold / 2
            ? "degraded"
            : "healthy",
        failCount: entry.failureCount,
        lastFailAt: new Date(),
      },
    });
  } catch (err) {
    console.error(
      `[circuit-breaker] 更新失败计数时数据库更新失败 (platformId=${platformId}):`,
      err
    );
  }
}

/**
 * 手动重置平台熔断器
 */
export async function resetCircuitBreaker(platformId: string): Promise<void> {
  breakers.delete(platformId);

  try {
    await prisma.platform.update({
      where: { id: platformId },
      data: { status: "healthy", failCount: 0, cooldownEnd: null },
    });
  } catch (err) {
    console.error(
      `[circuit-breaker] 手动重置时数据库更新失败 (platformId=${platformId}):`,
      err
    );
  }

  await forceRefreshRouterCache();
}

/**
 * 清理已删除平台的断路器条目
 */
export function cleanupStaleBreakers(activePlatformIds: string[]) {
  for (const [key] of breakers) {
    if (!activePlatformIds.includes(key)) {
      breakers.delete(key);
    }
  }
}
