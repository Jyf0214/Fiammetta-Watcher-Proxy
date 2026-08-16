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

import { describe, it, expect, beforeEach, vi } from "vitest";

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
  incrementHalfOpenPending,
  releaseHalfOpenPending,
  isHalfOpenProbeFull,
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

  it("incrementHalfOpenPending 递增半开状态并发计数", async () => {
    // 触发熔断 + 进入 half-open
    for (let i = 0; i < 5; i++) {
      await recordFailure("p1", mockDb);
    }
    vi.useFakeTimers();
    vi.advanceTimersByTime(61000);
    checkAndUpdateCircuitBreakerState("p1");
    vi.useRealTimers();

    // half-open 状态下递增 pending
    // DEFAULT_HALF_OPEN_MAX = 3
    incrementHalfOpenPending("p1");
    incrementHalfOpenPending("p1");
    incrementHalfOpenPending("p1");
    // 配额满：状态查询仍返回 half-open（不因配额满转换状态），
    // 配额满的放行控制由 selectPlatform 层（isHalfOpenProbeFull）负责
    expect(checkAndUpdateCircuitBreakerState("p1")).toBe("half-open");
    expect(isHalfOpenProbeFull("p1")).toBe(true);

    // 探测完成（成功）→ 转 closed，配额清零
    await recordSuccess("p1", mockDb);
    expect(isHalfOpenProbeFull("p1")).toBe(false);
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

    incrementHalfOpenPending("p1");
    incrementHalfOpenPending("p1");
    expect(isHalfOpenProbeFull("p1")).toBe(false);

    // 两个请求都在发出前被门禁拒绝 → 释放配额
    releaseHalfOpenPending("p1");
    releaseHalfOpenPending("p1");
    expect(isHalfOpenProbeFull("p1")).toBe(false);

    // 再占满：配额满时释放一个即恢复可探测
    incrementHalfOpenPending("p1");
    incrementHalfOpenPending("p1");
    incrementHalfOpenPending("p1");
    expect(isHalfOpenProbeFull("p1")).toBe(true);
    releaseHalfOpenPending("p1");
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
});
