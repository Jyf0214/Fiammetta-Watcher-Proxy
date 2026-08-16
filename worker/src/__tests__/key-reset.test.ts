/**
 * key-reset.ts 定时重置测试
 *
 * 覆盖：
 * - getPeriodStart（daily / monthly / never 返回 0）
 * - handleScheduledReset 批量重置逻辑
 *   - needsReset 判断（daily / monthly / never）
 *   - 重置 usedTokens → 0
 *   - disabled 状态不被周期重置自动复活
 *   - 仅清理保留期外日志
 *   - 平台异常状态恢复
 *
 * Mock @/lib/prisma 的 createDb
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock prisma
const mockFindMany = vi.fn();
const mockUpdate = vi.fn();
const mockDeleteMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(async () => ({
    apiKeys: {
      findMany: mockFindMany,
      update: mockUpdate,
    },
    platforms: {
      findMany: mockFindMany,
      update: mockUpdate,
    },
    requestLogs: {
      deleteMany: mockDeleteMany,
    },
  })),
}));

import { getPeriodStart, handleScheduledReset } from "../key-reset";

const mockDb = {} as D1Database;

// ==================== getPeriodStart ====================

describe("getPeriodStart", () => {
  it("daily 返回今天凌晨的 Unix 秒时间戳", () => {
    const result = getPeriodStart("daily");
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    expect(result).toBe(Math.floor(start.getTime() / 1000));
  });

  it("monthly 返回本月 1 号凌晨的 Unix 秒时间戳", () => {
    const result = getPeriodStart("monthly");
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    expect(result).toBe(Math.floor(start.getTime() / 1000));
  });

  it("never/未知值返回 0（不重置，窗口追溯到最早记录）", () => {
    expect(getPeriodStart("never")).toBe(0);
    expect(getPeriodStart("unknown")).toBe(0);
  });
});

// ==================== handleScheduledReset ====================

describe("handleScheduledReset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("无需要重置的 Key 时不执行更新", async () => {
    mockFindMany.mockResolvedValueOnce([]); // apiKeys
    mockFindMany.mockResolvedValueOnce([]); // platforms

    await handleScheduledReset(mockDb);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("daily Key 跨天时重置 usedTokens 且不恢复 disabled 状态", async () => {
    // 昨天更新的 daily key
    const yesterdayTs = Math.floor((Date.now() - 86400000) / 1000);
    mockFindMany.mockResolvedValueOnce([
      {
        id: "key-1",
        name: "Test Key",
        resetPeriod: "daily",
        usedTokens: 5000n,
        status: "disabled",
        updatedAt: yesterdayTs,
      },
    ]);
    mockFindMany.mockResolvedValueOnce([]); // platforms

    await handleScheduledReset(mockDb);

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "key-1" },
        data: expect.objectContaining({
          usedTokens: 0n,
        }),
      })
    );
    // disabled 是显式禁用状态，周期重置不得自动复活
    const updateCall = mockUpdate.mock.calls.find(
      (call) => call[0]?.where?.id === "key-1"
    );
    expect(updateCall![0].data.status).toBeUndefined();
  });

  it("never Key 不被查询（findMany where not never）", async () => {
    // findMany 已被 mock，验证 where 条件在调用参数中
    mockFindMany.mockResolvedValueOnce([]);
    mockFindMany.mockResolvedValueOnce([]);

    await handleScheduledReset(mockDb);

    // 第一次 findMany 是 apiKeys，验证 where 条件
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { resetPeriod: { not: "never" } },
      })
    );
  });

  it("同一天的 daily Key 不重置", async () => {
    const nowTs = Math.floor(Date.now() / 1000);
    mockFindMany.mockResolvedValueOnce([
      {
        id: "key-1",
        name: "Today Key",
        resetPeriod: "daily",
        usedTokens: 1000n,
        status: "active",
        updatedAt: nowTs,
      },
    ]);
    mockFindMany.mockResolvedValueOnce([]);

    await handleScheduledReset(mockDb);

    // apiKeys.update 不应被调用（没有需要重置的 key）
    // 但 platforms.update 可能被调用——验证 apiKeys 的 update 没被调用
    const apiUpdateCalls = mockUpdate.mock.calls.filter(
      (call) => call[0]?.data?.usedTokens !== undefined
    );
    expect(apiUpdateCalls.length).toBe(0);
  });

  it("不删除请求日志（保留期外日志由 log-archiver 归档时统一删除）", async () => {
    const yesterdayTs = Math.floor((Date.now() - 86400000) / 1000);
    mockFindMany.mockResolvedValueOnce([
      {
        id: "key-1",
        name: "Test Key",
        resetPeriod: "daily",
        usedTokens: 5000n,
        status: "active",
        updatedAt: yesterdayTs,
      },
    ]);
    mockFindMany.mockResolvedValueOnce([]);

    await handleScheduledReset(mockDb);

    // key-reset 不承担日志删除：archiver 未运行时直接删明细会造成统计空洞
    // （既不留在 request_logs 也不进 daily_stats），删除由归档任务全权负责
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it("平台 cooldown 过期时恢复为 healthy", async () => {
    const pastTs = Math.floor((Date.now() - 60000) / 1000);
    mockFindMany.mockResolvedValueOnce([]); // apiKeys
    mockFindMany.mockResolvedValueOnce([
      {
        id: "plat-1",
        name: "Platform1",
        status: "down",
        cooldownEnd: pastTs,
      },
    ]);

    await handleScheduledReset(mockDb);

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "plat-1" },
        data: expect.objectContaining({
          status: "healthy",
          failCount: 0,
          cooldownEnd: null,
        }),
      })
    );
  });

  it("平台 cooldown 未过期时不恢复", async () => {
    const futureTs = Math.floor((Date.now() + 60000) / 1000);
    mockFindMany.mockResolvedValueOnce([]); // apiKeys
    mockFindMany.mockResolvedValueOnce([
      {
        id: "plat-1",
        name: "Platform1",
        status: "down",
        cooldownEnd: futureTs,
      },
    ]);

    await handleScheduledReset(mockDb);

    // platforms update 不应被调用
    const platformUpdateCalls = mockUpdate.mock.calls.filter(
      (call) => call[0]?.data?.status === "healthy" && call[0]?.data?.failCount === 0
    );
    expect(platformUpdateCalls.length).toBe(0);
  });

  it("异常不抛出（静默捕获）", async () => {
    mockFindMany.mockRejectedValueOnce(new Error("DB connection failed"));
    // 不应 throw
    await expect(handleScheduledReset(mockDb)).resolves.toBeUndefined();
  });
});
