/**
 * 用量统计 API（pages/api/admin/usage.ts 与 pages/api/admin/usage/trend.ts）单元测试
 *
 * 覆盖（用量统计口径统一回归）：
 * usage.ts：
 * - GET 认证检查（401）
 * - TTFT/耗时均值分母排除错误请求（perfGrouped 仅 isError:false，错误请求不稀释均值）
 * - period=all 时 daily_stats 历史并入 + avgDuration×非错误请求数近似耗时总和
 * - period 非 all 时不读 daily_stats
 * - 数据库错误 500
 * trend.ts：
 * - GET 认证检查（401）
 * - TPS 整体除法（片内输出 Token 总和 / 片内耗时秒数总和，≠ 单请求 TPS 算术平均）
 * - 请求数全量口径（含错误请求）
 * - period=all 历史部分从 daily_stats 读 avgDuration 近似并入
 * - 数据库错误 500
 * usage/platform.ts：
 * - GET 认证检查（401）
 * - TTFT/耗时均值分母排除错误请求（perfGrouped 仅 isError:false）
 * - period=all 时 daily_stats 历史并入（按 platformId 聚合，null platformId 行跳过）
 * - 速率指标在请求数 <2 或同秒突发时返回 0（rateValid，与 usage.ts 同口径）
 * - period=today UTC 零点下界
 *
 * Mock 外部依赖：@/lib/prisma、@/lib/admin-auth
 * trend.ts 还 import worker/src/log-archiver 的 RETENTION_DAYS（仅常量 + createDb，
 * 无其他运行时依赖），由 @/lib/prisma 的 mock 覆盖。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";

// ==================== Mocks ====================

const mocks = vi.hoisted(() => ({
  apiKeysFindMany: vi.fn(),
  platformsFindMany: vi.fn(),
  requestLogsGroupBy: vi.fn(),
  requestLogsFindMany: vi.fn(),
  requestLogsAggregate: vi.fn(),
  dailyStatsFindMany: vi.fn(),
  getAdmin: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(async () => ({
    apiKeys: { findMany: mocks.apiKeysFindMany },
    platforms: { findMany: mocks.platformsFindMany },
    requestLogs: {
      groupBy: mocks.requestLogsGroupBy,
      findMany: mocks.requestLogsFindMany,
      aggregate: mocks.requestLogsAggregate,
    },
    dailyStats: { findMany: mocks.dailyStatsFindMany },
  })),
}));

vi.mock("@/lib/admin-auth", () => ({
  getAdminFromRequest: mocks.getAdmin,
}));

// ==================== Helpers ====================

import usageHandler from "../../../pages/api/admin/usage";
import trendHandler from "../../../pages/api/admin/usage/trend";
import platformUsageHandler from "../../../pages/api/admin/usage/platform";

function makeReq(overrides: any = {}): NextApiRequest {
  return {
    method: "GET",
    query: {},
    headers: { host: "example.com" },
    body: {},
    cookies: {},
    ...overrides,
  } as unknown as NextApiRequest;
}

function makeRes(): NextApiResponse {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: unknown;
  const res: any = {
    headers,
    status(c: number) { statusCode = c; return res; },
    json(b: unknown) { body = b; return res; },
    setHeader(k: string, v: string) { headers[k] = v; return res; },
    get statusCode() { return statusCode; },
    get body() { return body; },
  };
  return res;
}

async function callUsage(reqOverrides: any = {}) {
  const req = makeReq(reqOverrides);
  const res = makeRes() as any;
  await usageHandler(req, res);
  return { req, res };
}

async function callTrend(reqOverrides: any = {}) {
  const req = makeReq(reqOverrides);
  const res = makeRes() as any;
  await trendHandler(req, res);
  return { req, res };
}

/** usage.ts 的 groupBy 被调用两次：全量（无 isError）+ 性能（isError: false） */
function mockUsageGroupBy(grouped: any[], perfGrouped: any[]) {
  mocks.requestLogsGroupBy.mockImplementation(async (args: any) => {
    if (args.where && args.where.isError === false) return perfGrouped;
    return grouped;
  });
}

/** platform.ts 的 groupBy 被调用三次：全量（无 isError）+ 错误（isError: true）+ 性能（isError: false） */
function mockPlatformGroupBy(grouped: any[], errorGrouped: any[], perfGrouped: any[]) {
  mocks.requestLogsGroupBy.mockImplementation(async (args: any) => {
    if (args.where && args.where.isError === false) return perfGrouped;
    if (args.where && args.where.isError === true) return errorGrouped;
    return grouped;
  });
}

/** platform.ts 的 platforms.findMany 返回值（含 handler 用到的全部字段） */
function makePlatform(overrides: any = {}) {
  return {
    id: "plat-1",
    name: "平台 1",
    type: "openai",
    enabled: true,
    status: "healthy",
    baseUrl: "https://example.com",
    createdAt: 1700000000,
    ...overrides,
  };
}

/** trend.ts 的 findMany：take=1 是 period=all 的最早请求/最早历史探测，其余为明细分页 */
function mockTrendLogs(earliestLog: any[], detailLogs: any[]) {
  mocks.requestLogsFindMany.mockImplementation(async (args: any) => {
    if (args.take === 1) return earliestLog;
    return detailLogs;
  });
}

function mockTrendHist(earliestHist: any[], histRows: any[]) {
  mocks.dailyStatsFindMany.mockImplementation(async (args: any) => {
    if (args.take === 1) return earliestHist;
    return histRows;
  });
}

const ADMIN = { adminId: "env-admin", username: "admin" };

/** 测试用 Key（usedTokens 用 BigInt() 调用而非字面量，兼容 tsconfig ES2017 target） */
function makeKey(overrides: any = {}) {
  return {
    id: "key-1",
    name: "Key 1",
    key: "sk-abcdefghijklmnop",
    status: "active",
    tokenLimit: 100000,
    usedTokens: BigInt(500),
    createdAt: 1700000000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAdmin.mockResolvedValue(ADMIN);
  mocks.apiKeysFindMany.mockResolvedValue([makeKey()]);
  mocks.platformsFindMany.mockResolvedValue([]);
  mocks.requestLogsFindMany.mockResolvedValue([]);
  mocks.requestLogsAggregate.mockResolvedValue({ _max: { latency: null } });
  mocks.dailyStatsFindMany.mockResolvedValue([]);
});

// ==================== usage.ts ====================

describe("GET /api/admin/usage", () => {
  it("未认证返回 401", async () => {
    mocks.getAdmin.mockResolvedValue(null);
    const { res } = await callUsage();
    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("TTFT/耗时均值分母只计非错误请求，请求总数仍为全量（含错误）", async () => {
    // 全量 10 个请求、非错误 8 个；若分母误用全量，均值会被错误请求（ttft/latency=0）稀释
    mockUsageGroupBy(
      [
        {
          keyId: "key-1",
          _count: { id: 10 },
          _sum: { tokens: 10000, promptTokens: 4000, completionTokens: 6000, ttft: 5000, latency: 9000 },
          _min: { createdAt: 1000 },
          _max: { createdAt: 9000 },
        },
      ],
      [
        {
          keyId: "key-1",
          _count: { id: 8 },
          _sum: { ttft: 800, latency: 4000 },
        },
      ]
    );

    const { res } = await callUsage({ query: { period: "week" } });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    const stats = res.body.data[0].stats;
    // 分母 = 8（非错误），而非 10（全量）：800/8=100、4000/8=500
    expect(stats.totalRequests).toBe(10);
    expect(stats.avgTtft).toBe(100);
    expect(stats.avgDuration).toBe(500);
    expect(stats.totalTokens).toBe(10000);

    // 两次 groupBy：全量（无 isError 过滤）+ 性能（isError: false）
    expect(mocks.requestLogsGroupBy).toHaveBeenCalledTimes(2);
    expect(mocks.requestLogsGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ isError: false }) })
    );
    expect(mocks.requestLogsGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.not.objectContaining({ isError: false }) })
    );
    // period=week 未达归档界限，不读 daily_stats
    expect(mocks.dailyStatsFindMany).not.toHaveBeenCalled();
  });

  it("period=all 时 daily_stats 历史并入，avgDuration×非错误请求数近似耗时总和", async () => {
    mockUsageGroupBy(
      [
        {
          keyId: "key-1",
          _count: { id: 10 },
          _sum: { tokens: 1000, promptTokens: 400, completionTokens: 600, ttft: 500, latency: 1500 },
          _min: { createdAt: 1000 },
          _max: { createdAt: 2000 },
        },
      ],
      [
        {
          keyId: "key-1",
          _count: { id: 8 },
          _sum: { ttft: 400, latency: 1200 },
        },
      ]
    );
    mocks.dailyStatsFindMany.mockResolvedValue([
      {
        keyId: "key-1",
        date: 1700000000,
        totalRequests: 200,
        errorRequests: 20, // 非错误 180：avgTtft 100 → +18000，avgDuration 300 → +54000
        totalTokens: 100000,
        totalPromptTokens: 40000,
        totalCompletionTokens: 60000,
        avgTtft: 100,
        avgDuration: 300,
      },
      {
        keyId: "key-1",
        date: 1700086400,
        totalRequests: 100,
        errorRequests: 0, // 非错误 100：avgTtft=0 权重跳过，avgDuration 250 → +25000
        totalTokens: 50000,
        totalPromptTokens: 20000,
        totalCompletionTokens: 30000,
        avgTtft: 0,
        avgDuration: 250,
      },
    ]);

    // 不传 period → 默认 all → 触发 daily_stats 历史并入
    const { res } = await callUsage();
    expect(res.statusCode).toBe(200);
    expect(mocks.dailyStatsFindMany).toHaveBeenCalledTimes(1);

    const stats = res.body.data[0].stats;
    // 请求数/Token：明细 + 历史全量合并
    expect(stats.totalRequests).toBe(10 + 200 + 100);
    expect(stats.totalTokens).toBe(1000 + 100000 + 50000);
    expect(stats.promptTokens).toBe(400 + 40000 + 20000);
    expect(stats.completionTokens).toBe(600 + 60000 + 30000);
    // 均值：分子 = 明细 ttft/latency 总和 + 历史 avg×非错误请求数近似
    // perfCount = 8 + 180 + 100 = 288
    // avgTtft = round((400 + 100×180) / 288) = round(63.89) = 64
    // avgDuration = round((1200 + 300×180 + 250×100) / 288) = round(278.47) = 278
    expect(stats.avgTtft).toBe(64);
    expect(stats.avgDuration).toBe(278);
  });

  it("peakDuration：取窗口内最大 latency（毫秒换算秒），两种响应形态均含顶层字段", async () => {
    mockUsageGroupBy(
      [
        {
          keyId: "key-1",
          _count: { id: 2 },
          _sum: { tokens: 100, promptTokens: 40, completionTokens: 60, ttft: 100, latency: 12000 },
          _min: { createdAt: 1000 },
          _max: { createdAt: 2000 },
        },
      ],
      [
        {
          keyId: "key-1",
          _count: { id: 2 },
          _sum: { ttft: 100, latency: 12000 },
        },
      ]
    );
    // 窗口内最大 latency = 9000ms → 9s（F5 接口约定：秒）
    mocks.requestLogsAggregate.mockResolvedValue({ _max: { latency: 9000 } });

    const { res } = await callUsage({ query: { period: "week" } });
    expect(res.statusCode).toBe(200);
    expect(res.body.peakDuration).toBe(9);
    expect(res.body.data[0].id).toBe("key-1");

    // keyId 形态同样携带顶层 peakDuration
    const { res: resById } = await callUsage({ query: { period: "week", keyId: "key-1" } });
    expect(resById.statusCode).toBe(200);
    expect(resById.body.peakDuration).toBe(9);
    // keyId 过滤传入了 aggregate where（与 groupBy 相同下界）
    expect(mocks.requestLogsAggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ keyId: "key-1" }) })
    );
  });

  it("peakDuration：窗口内无有效耗时（无日志/全为错误请求）返回 null", async () => {
    mockUsageGroupBy([], []);
    mocks.requestLogsAggregate.mockResolvedValue({ _max: { latency: null } });
    const { res } = await callUsage({ query: { period: "week" } });
    expect(res.statusCode).toBe(200);
    expect(res.body.peakDuration).toBeNull();
  });

  it("peakDuration：aggregate 仅统计非错误请求（isError: false），错误请求真实耗时（最高 120s）不污染峰值", async () => {
    mockUsageGroupBy(
      [
        {
          keyId: "key-1",
          _count: { id: 2 },
          _sum: { tokens: 100, promptTokens: 40, completionTokens: 60, ttft: 100, latency: 12000 },
          _min: { createdAt: 1000 },
          _max: { createdAt: 2000 },
        },
      ],
      [
        {
          keyId: "key-1",
          _count: { id: 1 },
          _sum: { ttft: 100, latency: 12000 },
        },
      ]
    );
    // 若未过滤，错误请求（如 120000ms 超时）会覆盖非错误峰值 9000ms；
    // 过滤后 aggregate 只见非错误请求 → 9000ms → 9s
    mocks.requestLogsAggregate.mockResolvedValue({ _max: { latency: 9000 } });

    const { res } = await callUsage({ query: { period: "week" } });
    expect(res.statusCode).toBe(200);
    expect(res.body.peakDuration).toBe(9);
    // 核心断言：peakAgg 的 where 与 perfGrouped 同款 isError: false（错误请求不参与峰值）
    expect(mocks.requestLogsAggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isError: false }),
      })
    );
  });

  it("peakDuration：period=all 时并入 daily_stats.maxDuration（已归档历史峰值不缩水）", async () => {
    mockUsageGroupBy([], []);
    // 明细最大 3000ms，历史归档最大 120000ms → 峰值取 120s
    mocks.requestLogsAggregate.mockResolvedValue({ _max: { latency: 3000 } });
    mocks.dailyStatsFindMany.mockResolvedValue([
      {
        keyId: "key-1",
        date: 1700000000,
        totalRequests: 200,
        errorRequests: 20,
        totalTokens: 100000,
        totalPromptTokens: 40000,
        totalCompletionTokens: 60000,
        avgTtft: 100,
        avgDuration: 300,
        maxDuration: 120000,
      },
    ]);
    const { res } = await callUsage(); // 默认 period=all
    expect(res.statusCode).toBe(200);
    expect(res.body.peakDuration).toBe(120);
  });

  it("period=today 使用 UTC 零点作为过滤下界（与归档 UTC 天口径一致，A11）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T10:30:00Z"));
    mockUsageGroupBy([], []);
    try {
      const { res } = await callUsage({ query: { period: "today" } });
      expect(res.statusCode).toBe(200);
      // 2026-08-18T00:00:00Z（UTC 零点，86400 整数倍）；若误用本地零点，
      // 非 UTC 时区下将取到错误下界
      const fullWhere = mocks.requestLogsGroupBy.mock.calls
        .map((c) => c[0] as any)
        .find((a) => !(a?.where?.isError === false))!.where;
      expect(fullWhere.createdAt.gte).toBe(1787011200);
      expect(fullWhere.createdAt.gte % 86400).toBe(0);
      // peakDuration 的 aggregate 使用同一 UTC 零点下界
      expect(mocks.requestLogsAggregate).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ createdAt: { gte: 1787011200 } }) })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("数据库错误返回 500", async () => {
    mocks.requestLogsGroupBy.mockRejectedValue(new Error("DB error"));
    const { res } = await callUsage();
    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
  });
});

// ==================== trend.ts ====================

describe("GET /api/admin/usage/trend", () => {
  it("未认证返回 401", async () => {
    mocks.getAdmin.mockResolvedValue(null);
    const { res } = await callTrend();
    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("TPS 用整体除法：片内输出 Token 总和 / 片内耗时秒数总和，而非单请求 TPS 算术平均", async () => {
    // 同一天两个请求：
    //   req1: completion=100, latency=1000ms → 单请求 TPS 100
    //   req2: completion=100, latency=3000ms → 单请求 TPS 33.33
    // 算术平均 = 66.67；整体除法 = 200 tokens / 4s = 50
    const base = new Date();
    base.setHours(12, 0, 0, 0); // 本地今天中午，两个请求必然同片
    const baseTs = Math.floor(base.getTime() / 1000);
    mockTrendLogs([], [
      { tokens: 500, promptTokens: 400, completionTokens: 100, latency: 1000, createdAt: baseTs },
      { tokens: 500, promptTokens: 400, completionTokens: 100, latency: 3000, createdAt: baseTs + 60 },
    ]);

    const { res } = await callTrend(); // 默认 period=month
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    const point = res.body.data[0];
    expect(point.requests).toBe(2);
    expect(point.completionTokens).toBe(200);
    expect(point.tps).toBe(50);
  });

  it("请求数全量口径：错误请求计入 requests，但耗时不计入 TPS 分母", async () => {
    const base = new Date();
    base.setHours(12, 0, 0, 0);
    const baseTs = Math.floor(base.getTime() / 1000);
    mockTrendLogs([], [
      { tokens: 100, promptTokens: 50, completionTokens: 50, latency: 1000, isError: false, createdAt: baseTs },
      { tokens: 200, promptTokens: 100, completionTokens: 100, latency: 2000, isError: false, createdAt: baseTs + 60 },
      // 错误请求：tokens 恒 0 但 latency 是真实耗时，必须排除在 TPS 分母外
      { tokens: 0, promptTokens: 0, completionTokens: 0, latency: 5000, isError: true, createdAt: baseTs + 120 },
    ]);

    const { res } = await callTrend();
    expect(res.statusCode).toBe(200);
    const point = res.body.data[0];
    expect(point.requests).toBe(3);
    expect(point.tokens).toBe(300);
    // 耗时总和只计非错误 = 3000ms（错误请求 5000ms 不入分母）→ TPS = 150 tokens / 3s = 50
    expect(point.tps).toBe(50);
  });

  it("period=all 历史部分从 daily_stats 读 avgDuration×非错误请求数近似并入", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const todayStart = nowSec - (nowSec % 86400);
    const detailSince = todayStart - 30 * 86400;

    // 最早请求/最早历史均早于明细下界（30 天）→ 触发历史并入
    mockTrendLogs([{ createdAt: nowSec - 100 * 86400 }], [
      { tokens: 100, promptTokens: 60, completionTokens: 40, latency: 1000, createdAt: detailSince + 1000 },
    ]);
    mockTrendHist([{ date: nowSec - 90 * 86400 }], [
      {
        date: nowSec - 60 * 86400, // 落在 [startTimestamp, detailSince] 区间内
        totalRequests: 200,
        errorRequests: 20, // 非错误 180 → latencyMs = 300×180 = 54000ms = 54s
        totalTokens: 100000,
        totalPromptTokens: 40000,
        totalCompletionTokens: 60000,
        avgDuration: 300,
      },
      {
        date: nowSec - 50 * 86400,
        totalRequests: 50,
        errorRequests: 50, // 非错误 0 → latencyMs = 0 → tps = 0
        totalTokens: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        avgDuration: 0,
      },
    ]);

    const { res } = await callTrend({ query: { period: "all" } });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    // 历史查询携带归档界限：date ∈ [startTimestamp, detailSince]
    expect(mocks.dailyStatsFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ date: expect.objectContaining({ gte: expect.any(Number), lte: expect.any(Number) }) }),
      })
    );

    const points = res.body.data as Array<{ date: string; requests: number; tps: number }>;
    const byRequests = new Map(points.map((p) => [p.requests, p]));

    // 历史点 1：请求数含错误请求（200），TPS = 60000 / 54s = 1111.11
    const histPoint = byRequests.get(200);
    expect(histPoint).toBeDefined();
    expect(histPoint!.tps).toBe(1111.11);
    // 历史点 2：avgDuration=0（无样本）→ latencyMs=0 → tps=0
    const emptyPoint = byRequests.get(50);
    expect(emptyPoint).toBeDefined();
    expect(emptyPoint!.tps).toBe(0);
    // 明细点：TPS = 40 tokens / 1s = 40
    const detailPoint = byRequests.get(1);
    expect(detailPoint).toBeDefined();
    expect(detailPoint!.tps).toBe(40);

    // 三片总请求数 = 200 + 50 + 1（全量口径，含错误请求）
    const totalRequests = points.reduce((sum, p) => sum + p.requests, 0);
    expect(totalRequests).toBe(251);
  });

  it("日期分组按 UTC 天而非本地时区（dateKeyOf 与归档/统计口径一致，A5）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T10:30:00Z"));
    try {
      // UTC 日边界两侧各一条：2026-08-17T23:00Z 与 2026-08-18T01:00Z。
      // 本地时区（东八区等正偏移）下前者是 8-18 上午，旧实现会错误并入同日
      const utcMidnight = 1787011200; // 2026-08-18T00:00:00Z
      mockTrendLogs([], [
        { tokens: 100, promptTokens: 40, completionTokens: 60, latency: 1000, createdAt: utcMidnight - 3600 },
        { tokens: 200, promptTokens: 80, completionTokens: 120, latency: 2000, createdAt: utcMidnight + 3600 },
      ]);
      const { res } = await callTrend({ query: { period: "month" } });
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      const dates = (res.body.data as Array<{ date: string }>).map((p) => p.date).sort();
      expect(dates).toEqual(["2026-08-17", "2026-08-18"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("数据库错误返回 500", async () => {
    mocks.requestLogsFindMany.mockRejectedValue(new Error("DB error"));
    const { res } = await callTrend();
    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
  });
});

// ==================== usage/platform.ts ====================

describe("GET /api/admin/usage/platform", () => {
  it("未认证返回 401", async () => {
    mocks.getAdmin.mockResolvedValue(null);
    const req = makeReq();
    const res = makeRes() as any;
    await platformUsageHandler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("period=today 使用 UTC 零点作为过滤下界（与归档 UTC 天口径一致，A11）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T10:30:00Z"));
    mocks.requestLogsGroupBy.mockResolvedValue([]);
    try {
      const req = makeReq({ query: { period: "today" } });
      const res = makeRes() as any;
      await platformUsageHandler(req, res);
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      // 2026-08-18T00:00:00Z（UTC 零点，86400 整数倍）
      const fullWhere = mocks.requestLogsGroupBy.mock.calls
        .map((c) => c[0] as any)
        .find((a) => !(a?.where?.isError === true))!.where;
      expect(fullWhere.createdAt.gte).toBe(1787011200);
      expect(fullWhere.createdAt.gte % 86400).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("TTFT/耗时均值分母只计非错误请求，请求总数仍为全量（#2）", async () => {
    // 全量 10 个请求、非错误 8 个、错误 2 个；若分母误用全量，
    // 均值会被错误请求（ttft/latency=0）稀释
    mocks.platformsFindMany.mockResolvedValue([makePlatform()]);
    mockPlatformGroupBy(
      [
        {
          platformId: "plat-1",
          _count: { id: 10 },
          _sum: { tokens: 10000, promptTokens: 4000, completionTokens: 6000, ttft: 5000, latency: 9000 },
          _min: { createdAt: 1000 },
          _max: { createdAt: 9000 },
        },
      ],
      [{ platformId: "plat-1", _count: { id: 2 } }],
      [
        {
          platformId: "plat-1",
          _count: { id: 8 },
          _sum: { ttft: 800, latency: 4000 },
        },
      ]
    );

    const req = makeReq({ query: { period: "week" } });
    const res = makeRes() as any;
    await platformUsageHandler(req, res);
    expect(res.statusCode).toBe(200);
    const stats = res.body.data[0].stats;
    // 分母 = 8（非错误），而非 10（全量）：800/8=100、4000/8=500
    expect(stats.totalRequests).toBe(10);
    expect(stats.errorRequests).toBe(2);
    expect(stats.avgTtft).toBe(100);
    expect(stats.avgDuration).toBe(500);
    expect(stats.totalTokens).toBe(10000);

    // 3 次 groupBy：全量（无 isError 过滤）+ 错误（isError: true）+ 性能（isError: false）
    expect(mocks.requestLogsGroupBy).toHaveBeenCalledTimes(3);
    expect(mocks.requestLogsGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ isError: false }) })
    );
    expect(mocks.requestLogsGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ isError: true }) })
    );
    // period=week 未达归档界限，不读 daily_stats
    expect(mocks.dailyStatsFindMany).not.toHaveBeenCalled();
  });

  it("period=all 时 daily_stats 历史并入，按 platformId 聚合（#3）", async () => {
    mocks.platformsFindMany.mockResolvedValue([makePlatform()]);
    mockPlatformGroupBy(
      [
        {
          platformId: "plat-1",
          _count: { id: 10 },
          _sum: { tokens: 1000, promptTokens: 400, completionTokens: 600, ttft: 500, latency: 1500 },
          _min: { createdAt: 1000 },
          _max: { createdAt: 2000 },
        },
      ],
      [{ platformId: "plat-1", _count: { id: 1 } }],
      [
        {
          platformId: "plat-1",
          _count: { id: 9 },
          _sum: { ttft: 450, latency: 1350 },
        },
      ]
    );
    mocks.dailyStatsFindMany.mockResolvedValue([
      {
        platformId: "plat-1",
        date: 1700000000,
        totalRequests: 200,
        errorRequests: 20, // 非错误 180：avgTtft 100 → +18000，avgDuration 300 → +54000
        totalTokens: 100000,
        totalPromptTokens: 40000,
        totalCompletionTokens: 60000,
        avgTtft: 100,
        avgDuration: 300,
      },
      {
        platformId: "plat-1",
        date: 1700086400,
        totalRequests: 100,
        errorRequests: 0, // 非错误 100：avgTtft=0 权重跳过，avgDuration 250 → +25000
        totalTokens: 50000,
        totalPromptTokens: 20000,
        totalCompletionTokens: 30000,
        avgTtft: 0,
        avgDuration: 250,
      },
      {
        // platformId 为 null 的历史行不归属任何平台，必须跳过（不并入 statsMap 也不产生未知平台条目）
        platformId: null,
        date: 1700000000,
        totalRequests: 999,
        errorRequests: 0,
        totalTokens: 99999,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        avgTtft: 0,
        avgDuration: 0,
      },
    ]);

    // 不传 period → 默认 all → 触发 daily_stats 历史并入
    const req = makeReq();
    const res = makeRes() as any;
    await platformUsageHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(mocks.dailyStatsFindMany).toHaveBeenCalledTimes(1);

    const stats = res.body.data[0].stats;
    // 请求数/Token：明细 + 历史全量合并（null platformId 行不计入）
    expect(stats.totalRequests).toBe(10 + 200 + 100);
    expect(stats.totalTokens).toBe(1000 + 100000 + 50000);
    expect(stats.promptTokens).toBe(400 + 40000 + 20000);
    expect(stats.completionTokens).toBe(600 + 60000 + 30000);
    // 均值：分子 = 明细 ttft/latency 总和 + 历史 avg×非错误请求数近似
    // perfCount = 9 + 180 + 100 = 289
    // avgTtft = round((450 + 100×180) / 289) = round(63.84) = 64
    // avgDuration = round((1350 + 300×180 + 250×100) / 289) = round(278.03) = 278
    expect(stats.avgTtft).toBe(64);
    expect(stats.avgDuration).toBe(278);
    // 未知平台条目只由明细 null platformId 产出；历史 null 行已跳过 → 不出现
    expect(res.body.data.map((p: any) => p.id)).toEqual(["plat-1"]);
  });

  it("速率指标在请求数 <2 时返回 0（#23 反例，与 usage.ts 同口径）", async () => {
    mocks.platformsFindMany.mockResolvedValue([makePlatform()]);
    // 单请求：首末同一秒，timeSpan 0 被钳为 1 秒会得到 TPS=token 数、RPM=60 的失真值
    mockPlatformGroupBy(
      [
        {
          platformId: "plat-1",
          _count: { id: 1 },
          _sum: { tokens: 100, promptTokens: 40, completionTokens: 60, ttft: 100, latency: 1000 },
          _min: { createdAt: 1000 },
          _max: { createdAt: 1000 },
        },
      ],
      [],
      [
        {
          platformId: "plat-1",
          _count: { id: 1 },
          _sum: { ttft: 100, latency: 1000 },
        },
      ]
    );

    const req = makeReq({ query: { period: "week" } });
    const res = makeRes() as any;
    await platformUsageHandler(req, res);
    expect(res.statusCode).toBe(200);
    const stats = res.body.data[0].stats;
    expect(stats.totalRequests).toBe(1);
    expect(stats.avgTokensPerSecond).toBe(0);
    expect(stats.avgRequestsPerMinute).toBe(0);
  });

  it("速率指标在请求数 ≥2 且首末跨秒时正常计算（#23 正例）", async () => {
    mocks.platformsFindMany.mockResolvedValue([makePlatform()]);
    mockPlatformGroupBy(
      [
        {
          platformId: "plat-1",
          _count: { id: 2 },
          _sum: { tokens: 200, promptTokens: 80, completionTokens: 120, ttft: 200, latency: 4000 },
          _min: { createdAt: 1000 },
          _max: { createdAt: 2000 },
        },
      ],
      [],
      [
        {
          platformId: "plat-1",
          _count: { id: 2 },
          _sum: { ttft: 200, latency: 4000 },
        },
      ]
    );

    const req = makeReq({ query: { period: "week" } });
    const res = makeRes() as any;
    await platformUsageHandler(req, res);
    expect(res.statusCode).toBe(200);
    const stats = res.body.data[0].stats;
    // timeSpan = 2000 - 1000 = 1000s
    // avgTokensPerSecond = 200/1000 = 0.2
    // avgRequestsPerMinute = (2/1000)×60 = 0.12
    expect(stats.avgTokensPerSecond).toBe(0.2);
    expect(stats.avgRequestsPerMinute).toBe(0.12);
  });
});
