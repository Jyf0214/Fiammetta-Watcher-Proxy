/**
 * 统计 API（pages/api/admin/stats.ts）单元测试
 *
 * 覆盖：
 * - GET 认证检查
 * - 历史数据（daily_stats）+ 明细数据（request_logs）聚合
 * - 缓存命中
 * - 数据库错误 500
 *
 * Mock 外部依赖：@/lib/prisma、@/lib/admin-auth、@opennextjs/cloudflare
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";

// ==================== Mocks ====================

const mockCount = vi.fn();
const mockDetailAgg = vi.fn();
const mockPerfAgg = vi.fn();
const mockDailyStatsFindMany = vi.fn();

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(async () => ({
    platforms: { count: mockCount },
    apiKeys: { count: mockCount },
    requestLogs: {
      aggregate: vi.fn(async (args: any) => {
        // 第一次调用是 detailAgg（无 isError 过滤），第二次是 perfAgg（有 isError: false）
        if (args.where && args.where.isError === false) return mockPerfAgg();
        return mockDetailAgg();
      }),
    },
    dailyStats: { findMany: mockDailyStatsFindMany },
  })),
}));

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    throw new Error("no Cloudflare context");
  },
}));

const mockGetAdmin = vi.fn();
vi.mock("@/lib/admin-auth", () => ({
  getAdminFromRequest: mockGetAdmin,
}));

// ==================== Helpers ====================

// stats.ts 有模块级缓存，每次测试需要重置模块
async function loadHandler() {
  vi.resetModules();
  const mod = await import("../../../pages/api/admin/stats");
  return mod.default;
}

function makeReq(overrides: any = {}): NextApiRequest {
  return {
    method: "GET",
    headers: { host: "example.com" },
    cookies: {},
    ...overrides,
  } as unknown as NextApiRequest;
}

function makeRes(): NextApiResponse & { body: unknown; statusCode: number } {
  let statusCode = 200;
  let body: unknown;
  const res: any = {
    status(c: number) { statusCode = c; return res; },
    json(b: unknown) { body = b; return res; },
    setHeader(k: string, v: string) { return res; },
    get statusCode() { return statusCode; },
    get body() { return body; },
  };
  return res;
}

const ADMIN = { adminId: "admin-1", username: "admin" };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAdmin.mockResolvedValue(ADMIN);
  mockCount.mockResolvedValue(5);
  // detailAgg: 所有请求（含错误）的 count + token 汇总
  mockDetailAgg.mockResolvedValue({
    _count: { id: 100 },
    _sum: { tokens: 50000 },
  });
  // perfAgg: 非错误请求的 TTFT/延迟/completionTokens 汇总
  mockPerfAgg.mockResolvedValue({
    _count: { id: 80 },
    _sum: { ttft: 8000, latency: 20000, completionTokens: 30000 },
  });
  mockDailyStatsFindMany.mockResolvedValue([]);
});

// ==================== Tests ====================

describe("GET /api/admin/stats", () => {
  it("未认证返回 401", async () => {
    mockGetAdmin.mockResolvedValue(null);
    const handler = await loadHandler();
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("认证成功返回统计数据", async () => {
    const handler = await loadHandler();
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.activePlatforms).toBe(5);
    expect(res.body.data.totalKeys).toBe(5);
    expect(res.body.data.totalRequests).toBe(100);
    expect(res.body.data.totalTokens).toBe(50000);
    expect(res.body.data.avgTtft).toBeDefined();
    expect(res.body.data.avgDuration).toBeDefined();
    expect(res.body.data.avgTps).toBeDefined();
  });

  it("daily_stats 历史数据正确累加", async () => {
    mockDailyStatsFindMany.mockResolvedValue([
      {
        totalRequests: 200,
        errorRequests: 20,
        totalTokens: 100000,
        avgTtft: 100,
        avgDuration: 300,
        avgTps: 50,
      },
      {
        totalRequests: 100,
        errorRequests: 10,
        totalTokens: 50000,
        avgTtft: 80,
        avgDuration: 250,
        avgTps: 40,
      },
    ]);

    const handler = await loadHandler();
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);

    // 历史 200+100=300 + 明细 100 = 400 总请求
    expect(res.body.data.totalRequests).toBe(300 + 100);
    // 历史 100000+50000=150000 + 明细 50000 = 200000 总 token
    expect(res.body.data.totalTokens).toBe(150000 + 50000);
  });

  it("缓存命中时直接返回不查库", async () => {
    const handler = await loadHandler();
    const req = makeReq();
    const res1 = makeRes();
    await handler(req, res1);
    expect(res1.statusCode).toBe(200);

    // 第二次调用应命中缓存
    const res2 = makeRes();
    await handler(req, res2);
    expect(res2.statusCode).toBe(200);

    // count 应只被调用 3 次（第一次请求：platforms.count + apiKeys.count x2）
    // 第二次请求命中缓存，不查库
    expect(mockCount).toHaveBeenCalledTimes(3);
  });

  it("avgTtft 正确计算（加权平均）", async () => {
    // perfAgg: 80 条非错误请求，ttft 总和 8000
    // detailAgg: 100 条总请求，tokens 50000
    // 历史无数据
    const handler = await loadHandler();
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);

    // avgTtft = 8000 / 80 = 100（使用非错误请求数做分母）
    expect(res.body.data.avgTtft).toBe(100);
    // avgDuration = 20000 / 80 = 250
    expect(res.body.data.avgDuration).toBe(250);
  });

  it("无数据时 avgTtft/avgDuration 为 0", async () => {
    mockDetailAgg.mockResolvedValue({
      _count: { id: 0 },
      _sum: { tokens: 0 },
    });
    mockPerfAgg.mockResolvedValue({
      _count: { id: 0 },
      _sum: { ttft: 0, latency: 0, completionTokens: 0 },
    });
    mockDailyStatsFindMany.mockResolvedValue([]);

    const handler = await loadHandler();
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);

    expect(res.body.data.totalRequests).toBe(0);
    expect(res.body.data.totalTokens).toBe(0);
    expect(res.body.data.avgTtft).toBe(0);
    expect(res.body.data.avgDuration).toBe(0);
  });

  it("数据库错误返回 500", async () => {
    mockCount.mockRejectedValue(new Error("DB error"));
    const handler = await loadHandler();
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
  });

  it("不支持的 HTTP 方法不限制（handler 不检查 method）", async () => {
    // stats handler 不检查 method，任何方法都走 GET 逻辑
    const handler = await loadHandler();
    const req = makeReq({ method: "POST" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });
});
