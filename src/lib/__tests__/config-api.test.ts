/**
 * 系统配置 API（pages/api/admin/config.ts）单元测试
 *
 * 覆盖：
 * - GET 未认证返回 401
 * - PUT 同秒两次保存：updatedAt 单调递增补偿（第二次 = 第一次 + 1），
 *   避免出站代理等模块以「updatedAt 等值比较」做缓存失效检查时误判无变化
 * - PUT 跨秒保存：updatedAt 取自然秒值（不叠加补偿）
 * - PUT 触发写操作限流（checkAdminRateLimit 按 adminId 计数）
 * - PUT 配置键必须以 system: 前缀（400）
 *
 * Mock 外部依赖：@/lib/prisma、@/lib/admin-auth、@/lib/admin-security、
 * @/lib/admin-rate-limit。模块级 lastConfigSaveAt 跨测试共享，每个用例用
 * vi.resetModules + 动态 import 取新模块实例（与 upstream-proxy.test.ts 一致）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";

// ==================== Mocks ====================

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  upsert: vi.fn(),
  getAdmin: vi.fn(),
  csrf: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(async () => ({
    configs: {
      findMany: mocks.findMany,
      upsert: mocks.upsert,
    },
  })),
}));

vi.mock("@/lib/admin-auth", () => ({
  getAdminFromRequest: mocks.getAdmin,
}));

vi.mock("@/lib/admin-security", () => ({
  checkCsrfOrigin: mocks.csrf,
}));

vi.mock("@/lib/admin-rate-limit", () => ({
  checkAdminRateLimit: mocks.rateLimit,
}));

// ==================== Helpers ====================

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

async function call(overrides: any = {}) {
  // 每次动态 import：lastConfigSaveAt 模块级状态按用例隔离
  const { default: handler } = await import("../../../pages/api/admin/config");
  const req = makeReq(overrides);
  const res = makeRes();
  await handler(req, res);
  return { req, res: res as any };
}

/** 同秒双 PUT 用的固定时间戳（毫秒），floor(/1000) = 1784000000 */
const T0 = 1_784_000_000_000;

const ADMIN = { adminId: "env-admin", username: "admin" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  mocks.getAdmin.mockResolvedValue(ADMIN);
  mocks.csrf.mockReturnValue(true);
  mocks.rateLimit.mockResolvedValue(true);
  mocks.findMany.mockResolvedValue([]);
  mocks.upsert.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

// ==================== 用例 ====================

describe("GET /api/admin/config", () => {
  it("未认证返回 401", async () => {
    mocks.getAdmin.mockResolvedValue(null);
    const { res } = await call();
    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

describe("PUT /api/admin/config updatedAt 单调递增补偿", () => {
  function putBody(key = "system:test_key", value = "v1") {
    return { method: "PUT", body: { key, value } };
  }

  /** 读取第 n 次 upsert 调用写入的 updatedAt（upsert 的 update 与 create 分支同值） */
  function savedUpdatedAt(callIndex: number): number {
    const args = mocks.upsert.mock.calls[callIndex][0];
    return (args.update?.updatedAt ?? args.create?.updatedAt) as number;
  }

  it("同秒两次 PUT：updatedAt 单调递增补偿（第二次 = 第一次 + 1）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0); // 秒 = 1784000000

    const first = await call(putBody("system:test_key", "a"));
    // 同一秒内（+500ms）再次保存
    vi.setSystemTime(T0 + 500);
    const second = await call(putBody("system:test_key", "b"));

    expect(first.res.statusCode).toBe(200);
    expect(second.res.statusCode).toBe(200);
    expect(mocks.upsert).toHaveBeenCalledTimes(2);

    const at1 = savedUpdatedAt(0);
    const at2 = savedUpdatedAt(1);
    // 同秒双保存不产生相同 updatedAt：第二次在自然秒值上 +1 补偿
    expect(at1).toBe(1_784_000_000);
    expect(at2).toBe(at1 + 1);
    expect(at2).not.toBe(at1);
  });

  it("跨秒两次 PUT：updatedAt 取自然秒值（不叠加补偿）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);

    await call(putBody("system:test_key", "a"));
    // 跨秒（+3s）：自然秒已前进，无需补偿
    vi.setSystemTime(T0 + 3_000);
    await call(putBody("system:test_key", "b"));

    const at1 = savedUpdatedAt(0);
    const at2 = savedUpdatedAt(1);
    expect(at1).toBe(1_784_000_000);
    expect(at2).toBe(1_784_000_003);
    // 等于自然秒值（时间前进 3 秒），而非上一值 +1
    expect(at2 - at1).toBe(3);
  });

  it("PUT 触发写操作限流（checkAdminRateLimit 按 adminId 计数）", async () => {
    const { res } = await call(putBody());
    expect(res.statusCode).toBe(200);
    expect(mocks.rateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.rateLimit).toHaveBeenCalledWith("env-admin", expect.anything());
  });

  it("配置键必须以 system: 前缀（非法键 400，不写库不计数）", async () => {
    const { res } = await call(putBody("other_key"));
    expect(res.statusCode).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
