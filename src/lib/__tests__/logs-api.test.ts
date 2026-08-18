/**
 * 请求日志 API（pages/api/admin/logs.ts）单元测试
 *
 * 覆盖（2026-08-17 审计修复回归）：
 * - status 查询参数：非法值 / 超 Int32 范围 → 400（此前超界值直接落入
 *   Prisma Int 过滤器触发校验失败 → 500）
 * - 日期筛选显式 UTC 口径：startDate=YYYY-MM-DD → T00:00:00Z 午夜，
 *   endDate=YYYY-MM-DD → T23:59:59.999Z 当天最后毫秒（此前 endDate 用
 *   setHours 走服务器本地时区，非 UTC 服务器当天 16:00 后日志被排除）
 * - 非法日期 → 400；正常查询返回分页数据
 *
 * Mock 外部依赖：@/lib/prisma、@/lib/admin-auth
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";

// ==================== Mocks ====================

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  count: vi.fn(),
  platformFindMany: vi.fn(),
  getAdmin: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(async () => ({
    requestLogs: {
      findMany: mocks.findMany,
      count: mocks.count,
    },
    platforms: {
      findMany: mocks.platformFindMany,
    },
  })),
}));

vi.mock("@/lib/admin-auth", () => ({
  getAdminFromRequest: mocks.getAdmin,
}));

// ==================== Helpers ====================

import handler from "../../../pages/api/admin/logs";

function makeReq(overrides: any = {}): NextApiRequest {
  return {
    method: "GET",
    headers: { host: "example.com" },
    body: {},
    cookies: {},
    query: {},
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

async function call(query: Record<string, string> = {}) {
  const req = makeReq({ query });
  const res = makeRes();
  await handler(req, res);
  return { req, res: res as any };
}

const ADMIN = { adminId: "admin-1", username: "admin" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAdmin.mockResolvedValue(ADMIN);
  mocks.findMany.mockResolvedValue([]);
  mocks.count.mockResolvedValue(0);
  mocks.platformFindMany.mockResolvedValue([]);
});

// ==================== 认证 ====================

describe("认证", () => {
  it("未认证返回 401", async () => {
    mocks.getAdmin.mockResolvedValue(null);
    const { res } = await call();
    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

// ==================== status 参数校验 ====================

describe("status 参数校验", () => {
  it("非法 status 返回 400", async () => {
    const { res } = await call({ status: "abc" });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("status");
  });

  it("超 Int32 范围的 status 返回 400（此前会触发 Prisma Int 校验失败 500）", async () => {
    const { res } = await call({ status: "99999999999" });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("status");
  });

  it("负数 status 返回 400", async () => {
    const { res } = await call({ status: "-1" });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("status");
  });

  it("合法 status 传入 Prisma where", async () => {
    const { res } = await call({ status: "200" });
    expect(res.statusCode).toBe(200);
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 200 }),
      })
    );
  });
});

// ==================== 日期筛选（显式 UTC 口径） ====================

describe("日期筛选", () => {
  it("startDate=YYYY-MM-DD 按 UTC 午夜解析", async () => {
    await call({ startDate: "2026-08-17" });
    const expected = Math.floor(new Date("2026-08-17T00:00:00Z").getTime() / 1000);
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: expect.objectContaining({ gte: expected }),
        }),
      })
    );
  });

  it("endDate=YYYY-MM-DD 按 UTC 当天最后毫秒解析（不随服务器本地时区漂移）", async () => {
    await call({ endDate: "2026-08-17" });
    const expected = Math.floor(new Date("2026-08-17T23:59:59.999Z").getTime() / 1000);
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: expect.objectContaining({ lte: expected }),
        }),
      })
    );
  });

  it("startDate 与 endDate 组合形成闭区间", async () => {
    await call({ startDate: "2026-08-01", endDate: "2026-08-17" });
    const gte = Math.floor(new Date("2026-08-01T00:00:00Z").getTime() / 1000);
    const lte = Math.floor(new Date("2026-08-17T23:59:59.999Z").getTime() / 1000);
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: expect.objectContaining({ gte, lte }),
        }),
      })
    );
  });

  it("完整 ISO 时间字符串仍直接解析（保留 ISO 格式支持）", async () => {
    await call({ startDate: "2026-08-17T12:00:00.000Z" });
    const expected = Math.floor(new Date("2026-08-17T12:00:00.000Z").getTime() / 1000);
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: expect.objectContaining({ gte: expected }),
        }),
      })
    );
  });

  it("非法日期返回 400", async () => {
    const { res } = await call({ startDate: "2026-13-99" });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("startDate");
  });

  it("超出 Int32 范围的日期返回 400", async () => {
    const { res } = await call({ startDate: "9999-12-31" });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("范围");
  });
});

// ==================== 正常查询 ====================

describe("正常查询", () => {
  it("返回分页数据与总数", async () => {
    mocks.count.mockResolvedValue(42);
    mocks.findMany.mockResolvedValue([
      {
        id: "log-1",
        model: "gpt-4o",
        status: 200,
        tokens: 100,
        promptTokens: 50,
        completionTokens: 50,
        ttft: 10,
        latency: 500,
        isError: false,
        errorMessage: null,
        ipAddress: "1.2.3.4",
        userAgent: "test",
        endpoint: "/v1/chat/completions",
        method: "POST",
        keyId: "k1",
        keyName: "main",
        platformId: "p1",
        cost: "0.001",
        createdAt: 1755360000,
      },
    ]);
    mocks.platformFindMany.mockResolvedValue([{ id: "p1", name: "OpenAI" }]);

    const { res } = await call({ page: "2", pageSize: "10" });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.total).toBe(42);
    expect(res.body.data.page).toBe(2);
    expect(res.body.data.pageSize).toBe(10);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].platformName).toBe("OpenAI");
    // createdAt 秒级时间戳转为 ISO 字符串
    expect(res.body.data.items[0].createdAt).toBe(
      new Date(1755360000 * 1000).toISOString()
    );
  });
});