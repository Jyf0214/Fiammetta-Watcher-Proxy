/**
 * load-balancer.ts 熔断器 + 负载均衡测试
 *
 * 覆盖：
 * - checkAndUpdateCircuitBreakerState 状态转换（closed/open/half-open）
 * - recordSuccess / recordFailure 状态机
 * - selectPlatform 权重轮询 + 熔断过滤
 * - cleanupStaleBreakers
 * - syncCircuitBreakersFromDatabase
 *
 * Mock @/lib/prisma 的 createDb，避免真实数据库依赖
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock platform-keys — recordFailure/sync 会调 isPlatformWhitelisted
const { mockIsPlatformWhitelisted } = vi.hoisted(() => {
  const fn = vi.fn(() => false);
  return { mockIsPlatformWhitelisted: fn };
});
vi.mock("../platform-keys", () => ({
  isPlatformWhitelisted: mockIsPlatformWhitelisted,
}));

// Mock prisma — recordFailure/recordSuccess/sync 会调 updatePlatformStatus
const mockUpdate = vi.fn(async () => {});
const mockFindMany = vi.fn(async (): Promise<any[]> => []);
vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(async () => ({
    platforms: {
      update: mockUpdate,
      findMany: mockFindMany,
    },
  })),
}));

import {
  checkAndUpdateCircuitBreakerState,
  recordSuccess,
  recordFailure,
  selectPlatform,
  cleanupStaleBreakers,
  syncCircuitBreakersFromDatabase,
  releaseHalfOpenPending,
  isHalfOpenProbeFull,
  resetCircuitBreaker,
  isHighErrorRate,
  recordPlatform429,
  isPlatform429Cooldown,
  resetPlatform429,
} from "../load-balancer";
import type { PlatformConfig } from "@/lib/types";

const mockDb = {} as D1Database;

function makePlatform(overrides: Partial<PlatformConfig> = {}): PlatformConfig {
  return {
    id: "p1",
    name: "Platform1",
    baseUrl: "https://api.test.com/v1",
    apiKeys: ["sk-test"],
    type: "openai",
    enabled: true,
    priority: 0,
    weight: 1,
    rpmLimit: null,
    tpmLimit: null,
    forwardHeaders: "[]",
    status: "healthy",
    failCount: 0,
    lastFailAt: null,
    cooldownEnd: null,
    ...overrides,
  };
}

// ==================== 熔断器状态机 ====================

describe("熔断器状态机", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPlatformWhitelisted.mockReturnValue(false);
    // 重置内部 breakers Map：通过连续 recordFailure 触发 open 后再 recordSuccess 恢复
    // 或者直接利用模块状态——cleanupStaleBreakers([]) 清除所有
    cleanupStaleBreakers([]);
  });

  it("无熔断条目时 checkAndUpdateCircuitBreakerState 返回 closed", () => {
    expect(checkAndUpdateCircuitBreakerState("unknown")).toBe("closed");
  });

  it("连续失败达到阈值触发熔断 (closed → open)", async () => {
    const db = mockDb;
    // DEFAULT_FAILURE_THRESHOLD = 5
    for (let i = 0; i < 4; i++) {
      await recordFailure("p1", db);
      expect(checkAndUpdateCircuitBreakerState("p1")).toBe("closed");
    }
    // 第 5 次失败触发熔断
    await recordFailure("p1", db);
    expect(checkAndUpdateCircuitBreakerState("p1")).toBe("open");
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "p1" },
        data: expect.objectContaining({ status: "down" }),
      })
    );
  });

  it("open 状态冷却时间过后转为 half-open", async () => {
    // 触发熔断
    for (let i = 0; i < 5; i++) {
      await recordFailure("p1", mockDb);
    }
    expect(checkAndUpdateCircuitBreakerState("p1")).toBe("open");

    // 模拟时间前进超过冷却期（DEFAULT_COOLDOWN_MS = 60000）
    vi.useFakeTimers();
    vi.advanceTimersByTime(61000);
    expect(checkAndUpdateCircuitBreakerState("p1")).toBe("half-open");
    vi.useRealTimers();
  });

  it("half-open 状态成功 → 恢复 closed", async () => {
    // 触发熔断
    for (let i = 0; i < 5; i++) {
      await recordFailure("p1", mockDb);
    }
    // 进入 half-open
    vi.useFakeTimers();
    vi.advanceTimersByTime(61000);
    checkAndUpdateCircuitBreakerState("p1"); // 触发转换
    vi.useRealTimers();

    // 成功 → 恢复
    await recordSuccess("p1", mockDb);
    expect(checkAndUpdateCircuitBreakerState("p1")).toBe("closed");
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "p1" },
        data: expect.objectContaining({ status: "healthy", failCount: 0 }),
      })
    );
  });

  it("half-open 状态失败 → 回到 open", async () => {
    // 触发熔断
    for (let i = 0; i < 5; i++) {
      await recordFailure("p1", mockDb);
    }
    // 进入 half-open
    vi.useFakeTimers();
    vi.advanceTimersByTime(61000);
    checkAndUpdateCircuitBreakerState("p1");
    vi.useRealTimers();

    // 失败 → 回到 open
    await recordFailure("p1", mockDb);
    expect(checkAndUpdateCircuitBreakerState("p1")).toBe("open");
  });

  it("closed 状态成功清零失败计数", async () => {
    // 3 次失败（未达到阈值 5）
    for (let i = 0; i < 3; i++) {
      await recordFailure("p1", mockDb);
    }
    expect(checkAndUpdateCircuitBreakerState("p1")).toBe("closed");

    // 成功 → 清零
    await recordSuccess("p1", mockDb);
    expect(checkAndUpdateCircuitBreakerState("p1")).toBe("closed");

    // 再次失败应该从 1 开始计数，需要 5 次才熔断（而非 2 次就熔断）
    for (let i = 0; i < 4; i++) {
      await recordFailure("p1", mockDb);
      expect(checkAndUpdateCircuitBreakerState("p1")).toBe("closed");
    }
    // 第 5 次失败触发熔断
    await recordFailure("p1", mockDb);
    expect(checkAndUpdateCircuitBreakerState("p1")).toBe("open");
  });

  it("releaseHalfOpenPending 释放被门禁拒绝请求占用的探测配额", async () => {
    // 触发熔断 + 进入 half-open
    for (let i = 0; i < 5; i++) {
      await recordFailure("p1", mockDb);
    }
    vi.useFakeTimers();
    vi.advanceTimersByTime(61000);
    checkAndUpdateCircuitBreakerState("p1");
    vi.useRealTimers();

    const p1 = makePlatform({ id: "p1" });
    // 两个探测请求真实被 selectPlatform 选中（内联递增）→ 占用配额 2
    selectPlatform([p1]);
    selectPlatform([p1]);
    expect(isHalfOpenProbeFull("p1")).toBe(false);

    // 两个请求都在发出前被门禁拒绝 → 释放配额
    releaseHalfOpenPending("p1");
    releaseHalfOpenPending("p1");
    expect(isHalfOpenProbeFull("p1")).toBe(false);

    // 再占满：配额满时释放一个即恢复可探测
    selectPlatform([p1]);
    selectPlatform([p1]);
    selectPlatform([p1]);
    expect(isHalfOpenProbeFull("p1")).toBe(true);
    releaseHalfOpenPending("p1");
    expect(isHalfOpenProbeFull("p1")).toBe(false);

    // 探测完成（成功）→ 转 closed，配额清零
    await recordSuccess("p1", mockDb);
    expect(isHalfOpenProbeFull("p1")).toBe(false);
  });

  it("releaseHalfOpenPending 对非 half-open/零配额平台为无操作", async () => {
    // 未熔断（closed）平台：释放不应报错也不影响状态
    releaseHalfOpenPending("p1");
    expect(checkAndUpdateCircuitBreakerState("p1")).toBe("closed");
    // 零配额释放不产生负数
    for (let i = 0; i < 5; i++) {
      await recordFailure("p1", mockDb);
    }
    vi.useFakeTimers();
    vi.advanceTimersByTime(61000);
    checkAndUpdateCircuitBreakerState("p1");
    vi.useRealTimers();
    releaseHalfOpenPending("p1");
    expect(isHalfOpenProbeFull("p1")).toBe(false);
  });
});

// ==================== selectPlatform ====================

describe("selectPlatform", () => {
  beforeEach(() => {
    mockIsPlatformWhitelisted.mockReturnValue(false);
    cleanupStaleBreakers([]);
  });

  it("无可用平台返回 null", () => {
    expect(selectPlatform([])).toBeNull();
  });

  it("禁用的平台被跳过", () => {
    const p = makePlatform({ enabled: false });
    expect(selectPlatform([p])).toBeNull();
  });

  it("单个可用平台被选中", () => {
    const p = makePlatform();
    const result = selectPlatform([p]);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("p1");
  });

  it("高优先级平台优先被选中", () => {
    const low = makePlatform({ id: "low", priority: 0, weight: 100 });
    const high = makePlatform({ id: "high", priority: 10, weight: 1 });
    // 由于权重轮询有随机性，高优先级组只有一个平台时必选中
    const result = selectPlatform([low, high]);
    expect(result!.id).toBe("high");
  });

  it("熔断 open 的平台被跳过", async () => {
    // 熔断 p1
    for (let i = 0; i < 5; i++) {
      await recordFailure("p1", mockDb);
    }
    const p1 = makePlatform({ id: "p1" });
    const p2 = makePlatform({ id: "p2", weight: 1 });
    const result = selectPlatform([p1, p2]);
    expect(result!.id).toBe("p2");
  });

  it("cooldown 未过期的平台被跳过（cooldownEnd 为 Unix 秒）", () => {
    const now = Date.now();
    const p1 = makePlatform({ id: "p1", cooldownEnd: Math.floor((now + 60000) / 1000) });
    const p2 = makePlatform({ id: "p2" });
    const result = selectPlatform([p1, p2]);
    expect(result!.id).toBe("p2");
  });

  it("cooldown 已过期的平台可被选中（cooldownEnd 为 Unix 秒）", () => {
    const now = Date.now();
    const p1 = makePlatform({ id: "p1", cooldownEnd: Math.floor((now - 1000) / 1000) });
    const result = selectPlatform([p1]);
    expect(result!.id).toBe("p1");
  });

  it("所有平台熔断时返回 null", async () => {
    for (let i = 0; i < 5; i++) {
      await recordFailure("p1", mockDb);
      await recordFailure("p2", mockDb);
    }
    const platforms = [makePlatform({ id: "p1" }), makePlatform({ id: "p2" })];
    expect(selectPlatform(platforms)).toBeNull();
  });

  it("未选中的 half-open 平台不虚增探测计数（防自锁）", async () => {
    // 熔断 p1、p2 并进入 half-open
    for (const id of ["p1", "p2"]) {
      for (let i = 0; i < 5; i++) {
        await recordFailure(id, mockDb);
      }
    }
    vi.useFakeTimers();
    vi.advanceTimersByTime(61000);
    checkAndUpdateCircuitBreakerState("p1");
    checkAndUpdateCircuitBreakerState("p2");
    vi.useRealTimers();

    // 固定随机值使权重轮询总是选中第一个候选（p1）
    vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const p1 = makePlatform({ id: "p1" });
      const p2 = makePlatform({ id: "p2" });
      // 前 3 次选中 p1（真实占用配额），第 4 次 p1 配额满被排除后轮到 p2
      for (let i = 0; i < 4; i++) {
        selectPlatform([p1, p2]);
      }
    } finally {
      vi.restoreAllMocks();
    }
    // p1 被真实选中 3 次 → 配额满；p2 从未被选中 → 配额 0。
    // 旧实现在 filter 中对全部候选 +1，p2 会在 3 次调用后虚增满配额而永久排除（自锁）
    expect(isHalfOpenProbeFull("p1")).toBe(true);
    expect(isHalfOpenProbeFull("p2")).toBe(false);
  });
});

// ==================== cleanupStaleBreakers ====================

describe("cleanupStaleBreakers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPlatformWhitelisted.mockReturnValue(false);
    cleanupStaleBreakers([]);
  });

  it("清除不在活跃列表中的平台熔断条目", async () => {
    // 给 p1 和 p2 各添加一条熔断记录
    await recordFailure("p1", mockDb);
    await recordFailure("p2", mockDb);

    // 清理 p1 以外的
    cleanupStaleBreakers(["p1"]);
    // p1 仍然存在
    expect(checkAndUpdateCircuitBreakerState("p1")).toBe("closed");
    // p2 被清除
    expect(checkAndUpdateCircuitBreakerState("p2")).toBe("closed");
  });

  it("空列表清除所有条目", async () => {
    await recordFailure("p1", mockDb);
    await recordFailure("p2", mockDb);
    cleanupStaleBreakers([]);
    // 所有条目被清除，状态全部为 closed
    expect(checkAndUpdateCircuitBreakerState("p1")).toBe("closed");
    expect(checkAndUpdateCircuitBreakerState("p2")).toBe("closed");
  });
});

// ==================== syncCircuitBreakersFromDatabase ====================

describe("syncCircuitBreakersFromDatabase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPlatformWhitelisted.mockReturnValue(false);
    cleanupStaleBreakers([]);
  });

  it("down + cooldown 未过期 → open", async () => {
    const now = Date.now();
    mockFindMany.mockResolvedValueOnce([
      { id: "p1", status: "down", failCount: 5, cooldownEnd: Math.floor((now + 30000) / 1000) },
    ]);
    await syncCircuitBreakersFromDatabase(mockDb);
    expect(checkAndUpdateCircuitBreakerState("p1")).toBe("open");
  });

  it("down + cooldown 已过期 → half-open", async () => {
    mockFindMany.mockResolvedValueOnce([
      { id: "p1", status: "down", failCount: 5, cooldownEnd: Math.floor((Date.now() - 1000) / 1000) },
    ]);
    await syncCircuitBreakersFromDatabase(mockDb);
    expect(checkAndUpdateCircuitBreakerState("p1")).toBe("half-open");
  });

  it("degraded → closed（保留失败计数）", async () => {
    mockFindMany.mockResolvedValueOnce([
      { id: "p1", status: "degraded", failCount: 3, cooldownEnd: null },
    ]);
    await syncCircuitBreakersFromDatabase(mockDb);
    expect(checkAndUpdateCircuitBreakerState("p1")).toBe("closed");
  });

  it("healthy → 清除内存熔断条目", async () => {
    // 先创建一个熔断条目
    for (let i = 0; i < 5; i++) {
      await recordFailure("p1", mockDb);
    }
    expect(checkAndUpdateCircuitBreakerState("p1")).toBe("open");

    // 同步：数据库说 healthy
    mockFindMany.mockResolvedValueOnce([
      { id: "p1", status: "healthy", failCount: 0, cooldownEnd: null },
    ]);
    await syncCircuitBreakersFromDatabase(mockDb);
    expect(checkAndUpdateCircuitBreakerState("p1")).toBe("closed");
  });

  it("白名单平台：数据库 down 不同步为熔断状态（永不封禁语义）", async () => {
    mockIsPlatformWhitelisted.mockReturnValue(true);
    const now = Date.now();
    // 数据库中白名单平台状态为 down（历史遗留或手动失误）
    mockFindMany.mockResolvedValueOnce([
      { id: "whitelist-p", status: "down", failCount: 5, cooldownEnd: Math.floor((now + 30000) / 1000) },
    ]);
    await syncCircuitBreakersFromDatabase(mockDb);
    // 白名单平台永远不进入熔断状态
    expect(checkAndUpdateCircuitBreakerState("whitelist-p")).toBe("closed");
    // 同步过程未操作 breakers Map（没有条目需要设置）
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("白名单平台：数据库 degraded 不同步（recordFailure 不记录，永不降级）", async () => {
    mockIsPlatformWhitelisted.mockReturnValue(true);
    mockFindMany.mockResolvedValueOnce([
      { id: "whitelist-p", status: "degraded", failCount: 3, cooldownEnd: null },
    ]);
    await syncCircuitBreakersFromDatabase(mockDb);
    expect(checkAndUpdateCircuitBreakerState("whitelist-p")).toBe("closed");
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("白名单平台：已有熔断条目时同步清除（数据库 down → 内存清除）", async () => {
    mockIsPlatformWhitelisted.mockReturnValue(false);
    // 先用非白名单状态创建熔断条目
    for (let i = 0; i < 5; i++) {
      await recordFailure("whitelist-p", mockDb);
    }
    expect(checkAndUpdateCircuitBreakerState("whitelist-p")).toBe("open");

    // 同步时该平台变成白名单
    mockIsPlatformWhitelisted.mockReturnValue(true);
    mockFindMany.mockResolvedValueOnce([
      { id: "whitelist-p", status: "down", failCount: 5, cooldownEnd: Math.floor((Date.now() + 30000) / 1000) },
    ]);
    await syncCircuitBreakersFromDatabase(mockDb);
    // 白名单平台熔断条目被清除，永不封禁
    expect(checkAndUpdateCircuitBreakerState("whitelist-p")).toBe("closed");
  });

  it("白名单平台：同步清除熔断条目、高错误率窗口和 429 冷却（设计一致性）", async () => {
    mockIsPlatformWhitelisted.mockReturnValue(false);
    // 创建熔断条目
    for (let i = 0; i < 5; i++) {
      await recordFailure("whitelist-p", mockDb);
    }
    // 创建高错误率窗口（触发窗口错误率）
    for (let i = 0; i < 10; i++) {
      if (i % 5 < 3) await recordFailure("whitelist-p", mockDb);
      else await recordSuccess("whitelist-p", mockDb);
    }
    expect(isHighErrorRate("whitelist-p")).toBe(true);
    // 创建 429 冷却记录
    for (let i = 0; i < 5; i++) recordPlatform429("whitelist-p");
    expect(isPlatform429Cooldown("whitelist-p")).toBe(true);

    // 同步时该平台变成白名单
    mockIsPlatformWhitelisted.mockReturnValue(true);
    mockFindMany.mockResolvedValueOnce([
      { id: "whitelist-p", status: "down", failCount: 5, cooldownEnd: Math.floor((Date.now() + 30000) / 1000) },
    ]);
    await syncCircuitBreakersFromDatabase(mockDb);

    // 所有内存态均被清除
    expect(checkAndUpdateCircuitBreakerState("whitelist-p")).toBe("closed");
    expect(isHighErrorRate("whitelist-p")).toBe(false);
    expect(isPlatform429Cooldown("whitelist-p")).toBe(false);
  });

  it("白名单平台：recordFailure 不记录失败（熔断器永不推进）", async () => {
    mockIsPlatformWhitelisted.mockReturnValue(true);
    // 白名单平台 5 次失败
    for (let i = 0; i < 5; i++) {
      await recordFailure("whitelist-p", mockDb);
    }
    // 白名单平台永远保持 closed
    expect(checkAndUpdateCircuitBreakerState("whitelist-p")).toBe("closed");
    // 没有写 DB degraded（recordFailure 直接 return）
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

// ==================== #9 渐进降级（degraded） ====================

describe("渐进降级（#9）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPlatformWhitelisted.mockReturnValue(false);
    cleanupStaleBreakers([]);
  });

  it("closed 未达阈值时写 DB degraded 并递增 failCount", async () => {
    for (let i = 0; i < 3; i++) {
      await recordFailure("p1", mockDb);
    }
    expect(checkAndUpdateCircuitBreakerState("p1")).toBe("closed");
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "p1" },
        data: expect.objectContaining({ status: "degraded", failCount: 3, cooldownEnd: null }),
      })
    );
  });

  it("首次失败也写 degraded（无熔断条目时）", async () => {
    await recordFailure("p1", mockDb);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "degraded", failCount: 1 }),
      })
    );
  });

  it("达到阈值熔断时写 down（覆盖 degraded 状态转换）", async () => {
    for (let i = 0; i < 5; i++) {
      await recordFailure("p1", mockDb);
    }
    expect(checkAndUpdateCircuitBreakerState("p1")).toBe("open");
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "down", failCount: 5 }),
      })
    );
  });

  it("closed 失败后成功：DB degraded 同步回 healthy", async () => {
    await recordFailure("p1", mockDb);
    mockUpdate.mockClear();
    await recordSuccess("p1", mockDb);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "p1" },
        data: expect.objectContaining({ status: "healthy", failCount: 0, cooldownEnd: null }),
      })
    );
  });

  it("closed 无失败记录时成功不写库（健康路径零 DB 开销）", async () => {
    await recordSuccess("p1", mockDb);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

// ==================== resetCircuitBreaker（#10 解禁立即生效） ====================

describe("resetCircuitBreaker（#10）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPlatformWhitelisted.mockReturnValue(false);
    cleanupStaleBreakers([]);
  });

  it("清除 open 熔断条目后平台立即恢复可用", async () => {
    for (let i = 0; i < 5; i++) {
      await recordFailure("p1", mockDb);
    }
    expect(checkAndUpdateCircuitBreakerState("p1")).toBe("open");
    expect(selectPlatform([makePlatform({ id: "p1" })])).toBeNull();

    resetCircuitBreaker("p1");
    expect(checkAndUpdateCircuitBreakerState("p1")).toBe("closed");
    expect(selectPlatform([makePlatform({ id: "p1" })])!.id).toBe("p1");
  });

  it("resetCircuitBreaker 同时清除高错误率窗口", async () => {
    // 交替 6 败 4 胜（每 5 个采样里 3 败 2 胜）：连续失败未达阈值 5（成功穿插），
    // 但窗口错误率 60% 超阈值
    for (let i = 0; i < 10; i++) {
      if (i % 5 < 3) await recordFailure("p1", mockDb);
      else await recordSuccess("p1", mockDb);
    }
    expect(isHighErrorRate("p1")).toBe(true);

    resetCircuitBreaker("p1");
    expect(isHighErrorRate("p1")).toBe(false);
  });
});

// ==================== 滑动窗口错误率（间歇故障降级） ====================

describe("滑动窗口错误率", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPlatformWhitelisted.mockReturnValue(false);
    cleanupStaleBreakers([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("间歇故障（成功穿插）→ 连续失败熔断不触发但高错误率降级（此前放行）", async () => {
    // 交替 6 败 4 胜（每 5 个采样里 3 败 2 胜）：失败被成功穿插清零，
    // failureCount 永远达不到连续 5 次阈值；窗口错误率 60% > 50%，
    // 必须被调度层排除
    for (let i = 0; i < 10; i++) {
      if (i % 5 < 3) await recordFailure("p1", mockDb);
      else await recordSuccess("p1", mockDb);
    }

    expect(checkAndUpdateCircuitBreakerState("p1")).toBe("closed");
    expect(isHighErrorRate("p1")).toBe(true);
    expect(selectPlatform([makePlatform({ id: "p1" })])).toBeNull();
  });

  it("仅连续失败（无成功穿插）→ 熔断优先触发，错误率窗口同时累积", async () => {
    // 10 连败：第 5 次触发熔断（open），窗口同时累积 10 个样本
    // （100% 失败率，达到最小样本数）→ 双通道均判定
    for (let i = 0; i < 10; i++) await recordFailure("p1", mockDb);

    expect(checkAndUpdateCircuitBreakerState("p1")).toBe("open");
    expect(isHighErrorRate("p1")).toBe(true);
  });

  it("样本不足（<10）不判定：3 败 2 胜不降级", async () => {
    for (let i = 0; i < 3; i++) await recordFailure("p1", mockDb);
    for (let i = 0; i < 2; i++) await recordSuccess("p1", mockDb);

    expect(isHighErrorRate("p1")).toBe(false);
    expect(selectPlatform([makePlatform({ id: "p1" })])!.id).toBe("p1");
  });

  it("正常平台（10 胜）不降级", async () => {
    for (let i = 0; i < 10; i++) await recordSuccess("p1", mockDb);

    expect(isHighErrorRate("p1")).toBe(false);
  });

  it("窗口过期自动恢复参与调度（排除期间无新采样）", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let i = 0; i < 6; i++) await recordFailure("p1", mockDb);
    for (let i = 0; i < 4; i++) await recordSuccess("p1", mockDb);
    expect(selectPlatform([makePlatform({ id: "p1" })])).toBeNull();

    // 推进 5 分钟 + 1s（ERROR_RATE_WINDOW_MS = 5*60_000）：窗口过期 → 视为正常，重新参与调度
    vi.advanceTimersByTime(5 * 60 * 1000 + 1000);
    expect(isHighErrorRate("p1")).toBe(false);
    expect(selectPlatform([makePlatform({ id: "p1" })])!.id).toBe("p1");
  });

  it("半开恢复成功（recordSuccess half-open → closed）清空错误率窗口", async () => {
    // 先熔断（5 连败），冷却过期转 half-open，再成功恢复
    for (let i = 0; i < 5; i++) await recordFailure("p1", mockDb);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.advanceTimersByTime(61_000);
    expect(checkAndUpdateCircuitBreakerState("p1")).toBe("half-open");

    await recordSuccess("p1", mockDb);
    expect(checkAndUpdateCircuitBreakerState("p1")).toBe("closed");
    // 恢复期成功也计入窗口样本，但恢复时已清空：仅 1 胜 0 败，样本不足不降级
    expect(isHighErrorRate("p1")).toBe(false);
  });

  it("cleanupStaleBreakers 清理已删除平台的高错误率条目", async () => {
    // 交替 6 败 4 胜（每 5 个采样里 3 败 2 胜）
    for (let i = 0; i < 10; i++) {
      if (i % 5 < 3) await recordFailure("p1", mockDb);
      else await recordSuccess("p1", mockDb);
    }
    expect(isHighErrorRate("p1")).toBe(true);

    cleanupStaleBreakers(["other-platform"]);
    expect(isHighErrorRate("p1")).toBe(false);
  });
});

// ==================== 平台级 429 冷却 ====================

describe("平台级 429 冷却", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPlatformWhitelisted.mockReturnValue(false);
    cleanupStaleBreakers([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("窗口内 4 次 429 未达阈值不触发冷却", () => {
    for (let i = 0; i < 4; i++) recordPlatform429("p1");
    expect(isPlatform429Cooldown("p1")).toBe(false);
    expect(selectPlatform([makePlatform({ id: "p1" })])!.id).toBe("p1");
  });

  it("第 5 次 429 触发 30s 冷却，调度层排除该平台", () => {
    for (let i = 0; i < 5; i++) recordPlatform429("p1");
    expect(isPlatform429Cooldown("p1")).toBe(true);
    // 冷却中的平台被排除，其他平台正常承接
    const p1 = makePlatform({ id: "p1" });
    const p2 = makePlatform({ id: "p2" });
    expect(selectPlatform([p1, p2])!.id).toBe("p2");
  });

  it("冷却过期自动恢复参与调度", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let i = 0; i < 5; i++) recordPlatform429("p1");
    expect(selectPlatform([makePlatform({ id: "p1" })])).toBeNull();

    // 推进 30s + 1s（PLATFORM_429_COOLDOWN_MS = 30_000）：冷却过期 → 恢复
    vi.advanceTimersByTime(31_000);
    expect(isPlatform429Cooldown("p1")).toBe(false);
    expect(selectPlatform([makePlatform({ id: "p1" })])!.id).toBe("p1");
  });

  it("冷却结束后窗口内仍有累计计数 → 再次 429 立即重新进入冷却", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let i = 0; i < 5; i++) recordPlatform429("p1");
    vi.advanceTimersByTime(31_000);
    expect(isPlatform429Cooldown("p1")).toBe(false);

    // 冷却刚结束、60s 窗口未过期：再来一次 429 即重新冷却（持续过载）
    recordPlatform429("p1");
    expect(isPlatform429Cooldown("p1")).toBe(true);
  });

  it("60s 窗口过期后计数重建：4 次 429 不再触发冷却", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let i = 0; i < 5; i++) recordPlatform429("p1");
    expect(isPlatform429Cooldown("p1")).toBe(true);

    // 推进 60s + 1s（PLATFORM_429_WINDOW_MS = 60_000）：窗口重建，冷却也已过期
    vi.advanceTimersByTime(61_000);
    expect(isPlatform429Cooldown("p1")).toBe(false);
    for (let i = 0; i < 4; i++) recordPlatform429("p1");
    expect(isPlatform429Cooldown("p1")).toBe(false);
  });

  it("cleanupStaleBreakers 清理已删除平台的 429 冷却记录", () => {
    for (let i = 0; i < 5; i++) recordPlatform429("p1");
    expect(isPlatform429Cooldown("p1")).toBe(true);

    cleanupStaleBreakers(["other-platform"]);
    expect(isPlatform429Cooldown("p1")).toBe(false);
  });

  it("resetCircuitBreaker 清除 429 冷却（解禁立即生效）", () => {
    for (let i = 0; i < 5; i++) recordPlatform429("p1");
    expect(selectPlatform([makePlatform({ id: "p1" })])).toBeNull();

    resetCircuitBreaker("p1");
    expect(isPlatform429Cooldown("p1")).toBe(false);
    expect(selectPlatform([makePlatform({ id: "p1" })])!.id).toBe("p1");
  });

  it("resetPlatform429 直接清除冷却记录", () => {
    for (let i = 0; i < 5; i++) recordPlatform429("p1");
    expect(isPlatform429Cooldown("p1")).toBe(true);

    resetPlatform429("p1");
    expect(isPlatform429Cooldown("p1")).toBe(false);
  });
});
