/**
 * 负载均衡 + 熔断器
 *
 * 为平台选择提供：
 * - 平台状态检查（healthy / degraded / down）
 * - 熔断器状态管理（closed / open / half-open）
 * - 成功/失败记录触发状态转换
 * - 权重轮询选择平台
 */

import { createDb } from "@/lib/prisma";
import type { WorkerEnv } from "./config";
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

// ==================== 滑动窗口错误率 ====================

/**
 * 窗口错误率跟踪（独立于连续失败熔断）：
 *
 * 连续失败熔断只对"连败"敏感——recordSuccess 会清零 failureCount，失败只要有
 * 成功穿插（如每 2 分钟抖一下）就永远达不到阈值，间歇性高错误率的平台评分
 * 不降、负载均衡反复撞上它。错误率窗口用"滑动窗口内失败比例"判定：
 * 样本足量且失败率超阈值 → 调度层排除（高错误率降级），窗口过期自动恢复。
 *
 * 与熔断器状态机的关系：并行独立，互不干扰。连续失败熔断负责突发故障的
 * 快速响应（5 次即 open），错误率窗口负责慢速/间歇故障的持续降级。
 */
interface ErrorRateEntry {
  windowStart: number;
  failures: number;
  successes: number;
}

const errorRates = new Map<string, ErrorRateEntry>();
/** 错误率统计窗口：5 分钟（窗口过期即自动恢复参与调度，与冷却语义一致） */
const ERROR_RATE_WINDOW_MS = 5 * 60_000;
/** 窗口内最少样本数：低于此数不判定，避免小样本/单次偶发误伤 */
const ERROR_RATE_MIN_SAMPLES = 10;
/** 窗口内失败率阈值：超过则视为高错误率，调度层排除 */
const ERROR_RATE_THRESHOLD = 0.5;

/** 记录一次成功/失败样本（窗口过期则重建新窗口） */
function recordErrorRateSample(platformId: string, isError: boolean): void {
  const now = Date.now();
  let entry = errorRates.get(platformId);
  if (!entry || now - entry.windowStart >= ERROR_RATE_WINDOW_MS) {
    entry = { windowStart: now, failures: 0, successes: 0 };
    errorRates.set(platformId, entry);
  }
  if (isError) entry.failures++;
  else entry.successes++;
}

/**
 * 平台是否处于高错误率状态（窗口内失败率超阈值且样本足量）
 *
 * 窗口过期视为正常：排除期间无新请求采样，5 分钟后自动恢复参与调度，
 * 若平台仍坏则新请求继续失败、窗口再次累积——自愈循环与熔断冷却一致。
 */
export function isHighErrorRate(platformId: string): boolean {
  const entry = errorRates.get(platformId);
  if (!entry) return false;
  if (Date.now() - entry.windowStart >= ERROR_RATE_WINDOW_MS) return false;
  const total = entry.failures + entry.successes;
  if (total < ERROR_RATE_MIN_SAMPLES) return false;
  return entry.failures / total > ERROR_RATE_THRESHOLD;
}

/** 清除平台错误率窗口（半开恢复成功、手动解禁、定时任务恢复时调用） */
export function resetErrorRate(platformId: string): void {
  errorRates.delete(platformId);
}

// ==================== 平台级 429 冷却 ====================

/**
 * 平台级 429 冷却（独立于 Key 封禁与错误率窗口）：
 *
 * 429 是平台过载信号。Key 封禁只换 Key 不换平台，重试策略 1 会持续重打同一
 * 过载平台（最多 3 次）；错误率窗口要 ≥10 样本才判定，短时过载不会被快速识别。
 * 平台 429 冷却用"60s 窗口内累计 ≥5 次 429 → 平台冷却 30s"的粗粒度信号，
 * 过载平台在冷却期内被调度层排除（selectPlatform 不再选中），让上游有时间恢复；
 * 冷却结束后窗口内计数仍达阈值（持续过载）→ 再次进入冷却。
 */
interface Platform429Entry {
  windowStart: number;
  count: number;
  cooldownUntil: number;
}

const platform429s = new Map<string, Platform429Entry>();
/** 429 统计窗口：60 秒（与上游限流窗口同量级） */
const PLATFORM_429_WINDOW_MS = 60_000;
/** 窗口内触发冷却的 429 次数阈值 */
const PLATFORM_429_THRESHOLD = 5;
/** 触发后的冷却时长：30 秒（仅排除调度，不影响熔断器状态） */
const PLATFORM_429_COOLDOWN_MS = 30_000;

/** 记录一次平台 429（窗口内累计达到阈值则进入冷却） */
export function recordPlatform429(platformId: string): void {
  const now = Date.now();
  let entry = platform429s.get(platformId);
  if (!entry || now - entry.windowStart >= PLATFORM_429_WINDOW_MS) {
    entry = { windowStart: now, count: 0, cooldownUntil: 0 };
    platform429s.set(platformId, entry);
  }
  entry.count++;
  if (entry.count >= PLATFORM_429_THRESHOLD && now >= entry.cooldownUntil) {
    entry.cooldownUntil = now + PLATFORM_429_COOLDOWN_MS;
    console.log(
      `[circuit-breaker] 平台 ${platformId} 60s 窗口内累计 ${entry.count} 次 429，进入 ${PLATFORM_429_COOLDOWN_MS / 1000}s 冷却`
    );
  }
}

/** 平台是否处于 429 冷却（冷却期内调度层排除） */
export function isPlatform429Cooldown(platformId: string): boolean {
  const entry = platform429s.get(platformId);
  return !!entry && entry.cooldownUntil > Date.now();
}

/** 清除平台 429 冷却（手动解禁、定时任务恢复时调用） */
export function resetPlatform429(platformId: string): void {
  platform429s.delete(platformId);
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
    // 探测配额满的放行控制由 selectPlatform 层负责（isHalfOpenProbeFull），
    // 这里只做状态转换：pending 满不转换状态，等待进行中的探测完成后清零
    return "half-open";
  }

  return entry.state;
}

/**
 * 半开状态探测配额是否已满
 *
 * 配额满表示 DEFAULT_HALF_OPEN_MAX 个探测请求正在飞行中，
 * 该平台不能再承接新探测，直到进行中的探测完成（success/failure 清零）。
 */
export function isHalfOpenProbeFull(platformId: string): boolean {
  const entry = breakers.get(platformId);
  return (
    !!entry &&
    entry.state === "half-open" &&
    entry.halfOpenPending >= DEFAULT_HALF_OPEN_MAX
  );
}

/**
 * 释放半开探测配额
 *
 * 请求被选中 half-open 平台后、实际发出上游请求前被门禁拒绝
 * （平台/Key 级 RPM/TPM 限流）时不经过 recordSuccess/recordFailure，
 * 需在此显式释放，否则配额被占满后平台被排除、恢复探测饿死
 * （此前只能等 refreshCache 的 syncCircuitBreakersFromDatabase 归零）
 */
export function releaseHalfOpenPending(platformId: string): void {
  const entry = breakers.get(platformId);
  if (entry && entry.state === "half-open" && entry.halfOpenPending > 0) {
    entry.halfOpenPending--;
  }
}

/**
 * 记录请求成功 — 更新熔断器状态
 *
 * 成功时：
 * - closed → 保持 closed，清零失败计数；若此前失败已写库 degraded，同步回 healthy
 * - half-open → 转为 closed（恢复）
 */
export async function recordSuccess(
  platformId: string,
  db: D1Database,
  env?: WorkerEnv
): Promise<void> {
  const entry = breakers.get(platformId);
  // 错误率窗口记录成功样本（与熔断状态机并行）：间歇故障的成功穿插计入窗口，
  // 供 isHighErrorRate 以失败比例降级——不能因 success 清零 failureCount 就
  // 抹掉窗口累积
  recordErrorRateSample(platformId, false);

  if (!entry) return;

  if (entry.state === "half-open") {
    // 半开状态成功 → 恢复为 closed
    entry.state = "closed";
    entry.failureCount = 0;
    entry.halfOpenAttempts = 0;
    entry.halfOpenPending = 0;
    console.log(`[circuit-breaker] 平台 ${platformId} 恢复为 closed`);

    // 熔断恢复：清空错误率窗口（恢复期样本不代表稳态，避免恢复后立即再次降级）
    resetErrorRate(platformId);

    // 更新数据库状态
    await updatePlatformStatus(platformId, "healthy", 0, null, db, env);
  } else if (entry.state === "closed") {
    // closed 状态成功 → 清零失败计数；
    // 上次失败若已把 DB 写成 degraded，这里同步回 healthy（否则后台一直显示 degraded，
    // 只能等每小时 key-reset 恢复）
    if (entry.failureCount > 0) {
      entry.failureCount = 0;
      await updatePlatformStatus(platformId, "healthy", 0, null, db, env);
    }
  }
}

/**
 * 记录请求失败 — 更新熔断器状态
 *
 * 失败时：
 * - closed → 失败计数递增；未达阈值时渐进降级（写 DB degraded，不熔断），
 *   达到阈值则熔断（open）
 * - half-open → 失败则回到 open
 */
export async function recordFailure(
  platformId: string,
  db: D1Database,
  env?: WorkerEnv
): Promise<void> {
  const now = Date.now();
  // 错误率窗口记录失败样本（与熔断状态机并行）：供 isHighErrorRate 以失败
  // 比例降级——间歇故障（成功穿插）不会触发连续失败熔断，但窗口能识别
  recordErrorRateSample(platformId, true);

  let entry = breakers.get(platformId);

  if (!entry) {
    entry = {
      state: "closed",
      failureCount: 0,
      lastFailureAt: now,
      cooldownEnd: 0,
      halfOpenAttempts: 0,
      halfOpenPending: 0,
    };
    breakers.set(platformId, entry);
  }

  // 原子递增，防止并发竞态导致多计数
  const prevCount = entry.failureCount;
  entry.failureCount = prevCount + 1;
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

    await updatePlatformStatus(platformId, "down", entry.failureCount, entry.cooldownEnd, db, env);
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

    await updatePlatformStatus(platformId, "down", entry.failureCount, entry.cooldownEnd, db, env);
  } else if (entry.state === "closed") {
    // closed 未达阈值 → 渐进降级：写 DB degraded（管理后台可见，不打断请求），
    // 与 key-reset 的恢复逻辑对称（degraded 无冷却，cooldownEnd 为空，
    // 平台恢复后由 recordSuccess 或每小时 key-reset 写回 healthy）
    await updatePlatformStatus(platformId, "degraded", entry.failureCount, null, db, env);
  }
}

/**
 * 更新平台状态到数据库
 *
 * @param cooldownEnd 熔断器冷却结束时间（毫秒时间戳），存入数据库时转换为秒
 */
async function updatePlatformStatus(
  platformId: string,
  status: string,
  failCount: number,
  cooldownEnd: number | null,
  db: D1Database,
  env?: WorkerEnv
): Promise<void> {
  try {
    // 必须传 DB_TYPE：只传 DB 时 createDb 按默认 d1 连接，非 D1 部署下
    // 熔断器状态会写入 D1 空库，管理后台永远显示 healthy
    const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
    await prisma.platforms.update({
      where: { id: platformId },
      data: {
        status,
        failCount,
        lastFailAt: Math.floor(Date.now() / 1000),
        cooldownEnd: cooldownEnd !== null ? Math.floor(cooldownEnd / 1000) : null,
      },
    });
    console.log(
      `[circuit-breaker] 平台 ${platformId} 状态已更新: status=${status} failCount=${failCount}`
    );
  } catch (err) {
    console.error(
      `[circuit-breaker] 更新平台状态失败:`,
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * 从数据库同步熔断器状态（Worker 冷启动或缓存刷新时调用）
 *
 * - down：按 cooldownEnd 是否过期映射为 open / half-open
 * - degraded：closed（半失败状态，仅记录失败计数）
 * - healthy：清除内存中的熔断条目（手动恢复或熔断恢复后，避免与库不一致）
 */
export async function syncCircuitBreakersFromDatabase(db: D1Database, env?: WorkerEnv): Promise<void> {
  const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
  try {
    const platforms = await prisma.platforms.findMany({
      select: {
        id: true,
        status: true,
        failCount: true,
        cooldownEnd: true,
      },
    });

    const now = Date.now();
    let syncedCount = 0;

    for (const p of platforms) {
      if (p.status === "down") {
        // 库中 cooldownEnd 为秒级时间戳，先转为毫秒再比较
        const cooldownMs = (p.cooldownEnd ?? 0) * 1000;
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
      } else if (p.status === "healthy" && breakers.has(p.id)) {
        // 库中已恢复健康（手动恢复/熔断恢复）→ 清除内存熔断状态
        breakers.delete(p.id);
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
  // 同步清理已删除平台的错误率窗口，避免 Map 无限增长
  for (const [platformId] of errorRates) {
    if (!activeSet.has(platformId)) {
      errorRates.delete(platformId);
    }
  }
  // 同步清理已删除平台的 429 冷却记录
  for (const [platformId] of platform429s) {
    if (!activeSet.has(platformId)) {
      platform429s.delete(platformId);
    }
  }
}

/**
 * 清除平台的内存熔断条目（管理后台手动解禁时调用）
 *
 * 解禁后同步清内存态，使解禁立即生效——否则内存熔断条目还在 open 冷却中，
 * 最长 30 秒（缓存 TTL）后才被 refreshCache 的 syncCircuitBreakersFromDatabase
 * 看到 DB healthy 而清除，期间请求仍被 selectPlatform 拦截。
 */
export function resetCircuitBreaker(platformId: string): void {
  breakers.delete(platformId);
  resetErrorRate(platformId);
  resetPlatform429(platformId);
}

/**
 * 仅在熔断（open/half-open）时清除内存熔断条目（定时任务恢复平台时调用）
 *
 * 与 resetCircuitBreaker 的区别：closed 条目的 failureCount 是熔断阈值的一部分，
 * 无条件清除会导致慢速失败（每小时 3 次、无成功穿插）的平台计数每小时归零、
 * 永远达不到熔断阈值。degraded 平台 DB 恢复 healthy 时同样保留 closed 计数。
 */
export function resetCircuitBreakerIfTripped(platformId: string): void {
  const entry = breakers.get(platformId);
  if (entry && entry.state !== "closed") {
    breakers.delete(platformId);
  }
  // 平台恢复（定时任务）时错误率窗口一并清理，避免恢复后立即被旧窗口降级
  resetErrorRate(platformId);
  // 429 冷却一并清理：平台已恢复，不应继续被旧窗口排除
  resetPlatform429(platformId);
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
    if (breakerState === "half-open" && isHalfOpenProbeFull(p.id)) {
      // 半开探测配额已满：本调用不再新开探测。
      // 注意不能在 filter 中对所有候选 +1——未被选中的平台计数虚增，
      // 3 次调用后会被误判为配额满而永久排除（自锁）
      return false;
    }

    // 检查冷却期（数据库 cooldownEnd 为 Unix 秒，需与 Date.now() 的毫秒对齐）
    if (p.cooldownEnd !== null && p.cooldownEnd * 1000 > now) return false;

    // 高错误率降级（滑动窗口失败率）：间歇故障平台评分不降的问题由窗口识别，
    // 排除期间无新采样、窗口过期自动恢复（与熔断冷却的自动恢复语义一致）
    if (isHighErrorRate(p.id)) return false;

    // 平台 429 冷却：窗口内累计达阈值后平台过载，冷却期内排除调度，
    // 让上游限流窗口复位（区别于错误率窗口的"样本比例"判定，短时过载也能快速降权）
    if (isPlatform429Cooldown(p.id)) return false;

    return true;
  });

  if (available.length === 0) return null;

  // 按优先级分组
  const maxPriority = Math.max(...available.map((p) => p.priority));
  const topPriority = available.filter((p) => p.priority === maxPriority);

  // 权重轮询
  const totalWeight = topPriority.reduce((sum, p) => sum + p.weight, 0);
  let chosen: PlatformConfig | null = null;
  if (totalWeight <= 0) {
    chosen = topPriority[0] ?? null;
  } else {
    let random = Math.random() * totalWeight;
    for (const p of topPriority) {
      random -= p.weight;
      if (random <= 0) {
        chosen = p;
        break;
      }
    }
    if (!chosen) chosen = topPriority[topPriority.length - 1] ?? null;
  }

  // 仅在真正选中时占用半开探测配额（此前在 filter 阶段对全部候选计数，
  // 未被选中的 half-open 平台计数随每次 selectPlatform 调用虚增而从不走探测）
  if (chosen) {
    const entry = breakers.get(chosen.id);
    if (entry && entry.state === "half-open") entry.halfOpenPending++;
  }

  return chosen;
}
