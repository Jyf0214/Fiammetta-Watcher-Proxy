/**
 * validateApiKey Token 额度（tokenLimit）运行时检查测试
 *
 * tokenLimit 此前仅为管理后台字段，运行时从不检查（与套餐同性质的假功能）。
 * 本次在 auth.ts 增加检查：usedTokens 达到 tokenLimit 后返回 429。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateApiKey } from "../auth";
import type { WorkerEnv } from "../config";

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(),
}));

import { createDb } from "@/lib/prisma";

function makeKey(overrides: Record<string, unknown> = {}) {
  return {
    id: "key-id",
    key: "sk-test",
    name: "test",
    usedTokens: 0n,
    tokenLimit: null,
    rpmLimit: null,
    tpmLimit: null,
    callLimit: null,
    callUsed: 0,
    resetPeriod: "monthly",
    status: "active",
    expiresAt: null,
    updatedAt: 0,
    ...overrides,
  };
}

function mockFindFirst(record: unknown) {
  vi.mocked(createDb).mockResolvedValue({
    apiKeys: { findFirst: vi.fn(async () => record) },
  } as never);
}

const env = { DB_TYPE: "d1" } as WorkerEnv;

beforeEach(() => {
  vi.mocked(createDb).mockReset();
});

describe("validateApiKey tokenLimit 检查", () => {
  it("tokenLimit 为 null 时不限制（即使 usedTokens 很大）", async () => {
    mockFindFirst(makeKey({ usedTokens: 99999n, tokenLimit: null }));
    const result = await validateApiKey("Bearer sk-test", {} as D1Database, env);
    expect("apiKey" in result).toBe(true);
  });

  it("tokenLimit 为 0 时不限制（0 表示不设限制）", async () => {
    mockFindFirst(makeKey({ usedTokens: 99999n, tokenLimit: 0 }));
    const result = await validateApiKey("Bearer sk-test", {} as D1Database, env);
    expect("apiKey" in result).toBe(true);
  });

  it("usedTokens 未达 tokenLimit 时放行", async () => {
    mockFindFirst(makeKey({ usedTokens: 90n, tokenLimit: 100 }));
    const result = await validateApiKey("Bearer sk-test", {} as D1Database, env);
    expect("apiKey" in result).toBe(true);
  });

  it("usedTokens 恰好达到 tokenLimit 时返回 429", async () => {
    mockFindFirst(makeKey({ usedTokens: 100n, tokenLimit: 100 }));
    const result = await validateApiKey("Bearer sk-test", {} as D1Database, env);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(429);
      const body = (await result.error.json()) as { error?: { message?: string } };
      expect(body.error?.message).toContain("Token 额度已达上限");
    }
  });

  it("usedTokens 超过 tokenLimit 时返回 429", async () => {
    mockFindFirst(makeKey({ usedTokens: 150n, tokenLimit: 100 }));
    const result = await validateApiKey("Bearer sk-test", {} as D1Database, env);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(429);
    }
  });
});

// ==================== callLimit（W2：归档不回血） ====================

/**
 * callLimit 计数 = request_logs 未归档明细 + daily_stats 已归档部分求和。
 * 此前只 count request_logs：never 周期 Key 的计数随 log-archiver 归档"回血"
 * （30 天前明细被删后计数下降，已达上限的 Key 被重新放行）。
 */
function mockCallLimitDb(overrides: { recentCount?: number; archivedSum?: number | null } = {}) {
  const { recentCount = 0, archivedSum = 0 } = overrides;
  const dailyStatsAggregate = vi.fn(async () => ({ _sum: { totalRequests: archivedSum } }));
  vi.mocked(createDb).mockResolvedValue({
    apiKeys: {
      findFirst: vi.fn(async () => makeKey({ callLimit: 10, resetPeriod: "never" })),
    },
    requestLogs: {
      count: vi.fn(async () => recentCount),
    },
    dailyStats: {
      aggregate: dailyStatsAggregate,
    },
  } as never);
  return { dailyStatsAggregate };
}

describe("validateApiKey callLimit 检查（含 daily_stats 归档部分）", () => {
  it("request_logs 计数未达 callLimit 时放行，且 daily_stats 按 keyId + periodStart 过滤", async () => {
    const { dailyStatsAggregate } = mockCallLimitDb({ recentCount: 5, archivedSum: 0 });
    const result = await validateApiKey("Bearer sk-test", {} as D1Database, env);
    expect("apiKey" in result).toBe(true);

    // never 周期 periodStart = 0（追溯到最早），date 过滤条件必须带上
    expect(dailyStatsAggregate).toHaveBeenCalledWith({
      where: { keyId: "key-id", date: { gte: 0 } },
      _sum: { totalRequests: true },
    });
  });

  it("request_logs + daily_stats 归档部分合计达到 callLimit 时返回 429", async () => {
    // 未归档 3 次 + 已归档 7 次 = 10 = callLimit → 429（此前归档后只剩 3 会放行）
    mockCallLimitDb({ recentCount: 3, archivedSum: 7 });
    const result = await validateApiKey("Bearer sk-test", {} as D1Database, env);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(429);
      const body = (await result.error.json()) as { error?: { message?: string } };
      expect(body.error?.message).toContain("调用次数已达上限");
    }
  });

  it("归档部分累计（_sum 为 null 时按 0 计），未达上限时放行", async () => {
    mockCallLimitDb({ recentCount: 9, archivedSum: null });
    const result = await validateApiKey("Bearer sk-test", {} as D1Database, env);
    expect("apiKey" in result).toBe(true);
  });
});
