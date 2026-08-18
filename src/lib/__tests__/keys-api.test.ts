/**
 * API Key 管理 API（pages/api/admin/keys.ts）单元测试
 *
 * 覆盖：
 * - GET 列表（认证、密钥掩码）
 * - POST 创建（输入校验、成功创建、审计日志）
 * - 未认证 401、不支持方法 405
 *
 * Mock 外部依赖：@/lib/prisma、@/lib/admin-auth、@/lib/admin-rate-limit、@/lib/admin-security
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";

// ==================== Mocks ====================

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  auditCreate: vi.fn(),
  getAdmin: vi.fn(),
  getAuditAdminId: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(async () => ({
    apiKeys: {
      findMany: mocks.findMany,
      count: mocks.count,
      create: mocks.create,
    },
    auditLogs: {
      create: mocks.auditCreate,
    },
  })),
}));

vi.mock("@/lib/admin-auth", () => ({
  getAdminFromRequest: mocks.getAdmin,
  getAuditAdminId: mocks.getAuditAdminId,
}));

vi.mock("@/lib/admin-rate-limit", () => ({
  checkAdminRateLimit: mocks.checkRateLimit,
}));

vi.mock("@/lib/admin-security", () => ({
  checkCsrfOrigin: vi.fn(() => true),
}));

// ==================== Helpers ====================

import handler from "../../../pages/api/admin/keys";

function makeReq(overrides: any = {}): NextApiRequest {
  return {
    method: "GET",
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

async function call(reqOverrides: any = {}) {
  const req = makeReq(reqOverrides);
  const res = makeRes();
  await handler(req, res);
  return { req, res: res as any };
}

const ADMIN = { adminId: "admin-1", username: "admin" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAdmin.mockResolvedValue(ADMIN);
  mocks.checkRateLimit.mockResolvedValue(true);
  mocks.getAuditAdminId.mockReturnValue("env-admin");
  mocks.findMany.mockResolvedValue([]);
  mocks.create.mockResolvedValue({});
  mocks.auditCreate.mockResolvedValue({});
});

// ==================== GET ====================

describe("GET /api/admin/keys", () => {
  it("未认证返回 401", async () => {
    mocks.getAdmin.mockResolvedValue(null);
    const { res } = await call();
    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("认证成功返回 Key 列表（密钥掩码）", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "k1", name: "Key1", key: "sk-1234567890abcdef1234", status: "active" },
      { id: "k2", name: "Key2", key: "short", status: "disabled" },
    ]);

    const { res } = await call();
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
    // 长密钥应被掩码
    expect(res.body.data[0].key).toContain("...");
    expect(res.body.data[0].key).not.toBe("sk-1234567890abcdef1234");
    // 短密钥全掩
    expect(res.body.data[1].key).toBe("***");
    expect(res.body.total).toBe(2);
  });

  it("数据库错误返回 500", async () => {
    mocks.findMany.mockRejectedValue(new Error("DB error"));
    const { res } = await call();
    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
  });

  it("带 limit/offset 参数时返回分页形态 { data: { total, items } }", async () => {
    mocks.count.mockResolvedValue(3);
    mocks.findMany.mockResolvedValue([
      { id: "k1", name: "Key1", key: "sk-1234567890abcdef1234", status: "active", usedTokens: 10 },
    ]);

    const { res } = await call({ query: { limit: "10", offset: "2" } });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(false);
    expect(res.body.data.total).toBe(3);
    expect(res.body.data.items).toHaveLength(1);
    // 分页模式同样掩码
    expect(res.body.data.items[0].key).toContain("...");
    // usedTokens 转 number
    expect(res.body.data.items[0].usedTokens).toBe(10);
    // findMany 携带 take/skip
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10, skip: 2, orderBy: { createdAt: "desc" } })
    );
  });

  it("limit 钳制到 1~500（超上限取 500，低于下限取 1）", async () => {
    mocks.count.mockResolvedValue(0);
    mocks.findMany.mockResolvedValue([]);

    await call({ query: { limit: "99999" } });
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 500 }));

    await call({ query: { limit: "0" } });
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1 }));
  });

  it("limit 非法（非数字）时取默认 50，offset 非法取 0", async () => {
    mocks.count.mockResolvedValue(0);
    mocks.findMany.mockResolvedValue([]);

    const { res } = await call({ query: { limit: "abc", offset: "-5" } });
    expect(res.statusCode).toBe(200);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50, skip: 0 }));
    expect(res.body.data.total).toBe(0);
    expect(res.body.data.items).toEqual([]);
  });

  it("仅传 offset 也进入分页形态", async () => {
    mocks.count.mockResolvedValue(1);
    mocks.findMany.mockResolvedValue([{ id: "k1", name: "Key1", key: "sk-1234567890abcdef1234", status: "active" }]);

    const { res } = await call({ query: { offset: "5" } });
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toHaveProperty("total");
    expect(res.body.data).toHaveProperty("items");
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50, skip: 5 }));
  });
});

// ==================== POST ====================

describe("POST /api/admin/keys", () => {
  const validBody = {
    name: "Test Key",
    resetPeriod: "monthly",
  };

  it("未认证返回 401", async () => {
    mocks.getAdmin.mockResolvedValue(null);
    const { res } = await call({ method: "POST", body: validBody });
    expect(res.statusCode).toBe(401);
  });

  it("名称为空返回 400", async () => {
    const { res } = await call({ method: "POST", body: { ...validBody, name: "" } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.message).toContain("名称");
  });

  it("名称超 100 字符返回 400", async () => {
    const { res } = await call({ method: "POST", body: { ...validBody, name: "x".repeat(101) } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.message).toContain("100");
  });

  it("无效 resetPeriod 返回 400", async () => {
    const { res } = await call({
      method: "POST",
      body: { ...validBody, resetPeriod: "weekly" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.message).toContain("monthly");
  });

  it("rpmLimit 为负数返回 400", async () => {
    const { res } = await call({
      method: "POST",
      body: { ...validBody, rpmLimit: -1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.message).toContain("RPM");
  });

  it("tpmLimit 为负数返回 400", async () => {
    const { res } = await call({
      method: "POST",
      body: { ...validBody, tpmLimit: -10 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.message).toContain("TPM");
  });

  it("callLimit 为负数返回 400", async () => {
    const { res } = await call({
      method: "POST",
      body: { ...validBody, callLimit: -5 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.message).toContain("调用次数");
  });

  it("tokenLimit 非整数返回 400", async () => {
    const { res } = await call({
      method: "POST",
      body: { ...validBody, tokenLimit: 1.5 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.message).toContain("Token");
  });

  it("有效输入成功创建 Key", async () => {
    const { res } = await call({ method: "POST", body: validBody });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(res.body.message).toContain("成功");

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "Test Key",
          status: "active",
          usedTokens: 0,
          resetPeriod: "monthly",
        }),
      })
    );
  });

  it("创建时写入审计日志", async () => {
    await call({ method: "POST", body: validBody });
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "create_api_key",
          adminId: "env-admin",
        }),
      })
    );
  });

  it("生成的 Key 以 sk- 开头", async () => {
    await call({ method: "POST", body: validBody });
    const createCall = mocks.create.mock.calls[0][0];
    expect(createCall.data.key).toMatch(/^sk-/);
  });

  it("expiresAt 无效日期返回 400", async () => {
    const { res } = await call({
      method: "POST",
      body: { ...validBody, expiresAt: "not-a-date" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.message).toContain("日期");
  });
});

// ==================== 其他方法 ====================

describe("不支持的方法", () => {
  it("DELETE 返回 405", async () => {
    const { res } = await call({ method: "DELETE" });
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toEqual(["GET", "POST"]);
  });
});
