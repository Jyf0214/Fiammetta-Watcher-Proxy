/**
 * 统计 API（pages/api/admin/stats.ts）单元��试
 *
 * ����：
 * - GET 认证��查
 * - ��史数据（daily_stats）+ 明��数据（request_logs）��合
 * - ��存命中
 * - ��据库错误 500
 *
 * Mock 外部依��：@/lib/prisma、@/lib/admin-auth、@opennextjs/cloudflare
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
        // 第一次调用是 detailAgg（无 isError 过��），第二次是 perfAgg（有 isError: false）
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

// stats.ts 有模��级��存，每次��试需要重置模��
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

interface StatsResponseSuccess {
  success: true;
  data: {
    activePlatforms: number;
    totalKeys: number;
    activeKeys: number;
    totalRequests: number;
    totalTokens: number;
    avgTtft: number;
    avgDuration: number;
    avgTps: number;
  };
}
interface StatsResponseError {
  success: false;
  error: string;
}
type StatsResponse = StatsResponseSuccess | StatsResponseError;

function isSuccess(res: StatsResponse): res is StatsResponseSuccess {
  return res.success === true;
}

function makeRes(): NextApiResponse & { body: StatsResponse; statusCode: number } {
  let statusCode = 200;
  let body: StatsResponse = { success: false, error: "" };
  const res: any = {
    status(c: number) { statusCode = c; return res; },
    json(b: StatsResponse) { body = b; return res; },
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
  // detailAgg: 所有请求（含错误）的 count + token ��总
  mockDetailAgg.mockResolvedValue({
    _count: { id: 100 },
    _sum: { tokens: 50000 },
  });
  // perfAgg: 非错误请求的 TTFT/延��/completionTokens ��总
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
    if (!isSuccess(res.body)) throw new Error("Expected success response");
    expect(res.body.data).toBeDefined();
    expect(res.body.data.activePlatforms).toBe(5);
    expect(res.body.data.totalKeys).toBe(5);
    expect(res.body.data.totalRequests).toBe(100);
    expect(res.body.data.totalTokens).toBe(50000);
    expect(res.body.data.avgTtft).toBeDefined();
    expect(res.body.data.avgDuration).toBeDefined();
    expect(res.body.data.avgTps).toBeDefined();
  });

  it("daily_stats ��史数据正确��加", async () => {
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

    if (!isSuccess(res.body)) throw new Error("Expected success response");
    expect(res.body.data.totalRequests).toBe(300 + 100);
    expect(res.body.data.totalTokens).toBe(150000 + 50000);
  });

  it("��存命中时直接返回不查库", async () => {
    const handler = await loadHandler();
    const req = makeReq();
    const res1 = makeRes();
    await handler(req, res1);
    expect(res1.statusCode).toBe(200);

    const res2 = makeRes();
    await handler(req, res2);
    expect(res2.statusCode).toBe(200);

    expect(mockCount).toHaveBeenCalledTimes(3);
  });

  it("avgTtft 正确计算（加权平均）", async () => {
    const handler = await loadHandler();
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);

    if (!isSuccess(res.body)) throw new Error("Expected success response");
    expect(res.body.data.avgTtft).toBe(100);
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

    if (!isSuccess(res.body)) throw new Error("Expected success response");
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

  it("不支持的 HTTP 方法不限制（handler 不��查 method）", async () => {
    const handler = await loadHandler();
    const req = makeReq({ method: "POST" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });
});