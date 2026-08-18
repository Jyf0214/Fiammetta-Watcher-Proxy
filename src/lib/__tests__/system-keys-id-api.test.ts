/**
 * 系统 API Key 单个操作 API（pages/api/admin/system-keys/[id].ts）单元测试
 *
 * 覆盖：
 * - GET 单个 Key 明文（认证、404、返回明文而非掩码）
 * - 不支持方法 405
 *
 * Mock 外部依赖：@/lib/prisma、@/lib/admin-auth、@/lib/admin-security
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";

// ==================== Mocks ====================

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  getAdmin: vi.fn(),
  getAuditAdminId: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(async () => ({
    systemApiKeys: {
      findFirst: mocks.findFirst,
    },
  })),
}));

vi.mock("@/lib/admin-auth", () => ({
  getAdminFromRequest: mocks.getAdmin,
  getAuditAdminId: mocks.getAuditAdminId,
}));

vi.mock("@/lib/admin-security", () => ({
  checkCsrfOrigin: vi.fn(() => true),
}));

// ==================== Helpers ====================

import handler from "../../../pages/api/admin/system-keys/[id]";

function makeReq(overrides: any = {}): NextApiRequest {
  return {
    method: "GET",
    query: { id: "sys-001" },
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
  mocks.getAuditAdminId.mockReturnValue("env-admin");
  mocks.findFirst.mockResolvedValue(null);
});

// ==================== GET — 单个 Key 明文 ====================

describe("GET /api/admin/system-keys/[id]", () => {
  it("未认证返回 401", async () => {
    mocks.getAdmin.mockResolvedValue(null);
    const { res } = await call();
    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("Key 不存在返回 404", async () => {
    mocks.findFirst.mockResolvedValue(null);
    const { res } = await call();
    expect(res.statusCode).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("返回完整明文密钥（非掩码）", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "sys-001",
      key: "sk-sys-1234567890abcdef1234",
      name: "开发用 Key",
    });

    const { res } = await call();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, key: "sk-sys-1234567890abcdef1234" });
    // 必须是明文，不能带掩码
    expect(res.body.key).not.toContain("...");
    expect(res.body.key).not.toBe("***");
  });

  it("数据库错误返回 500", async () => {
    mocks.findFirst.mockRejectedValue(new Error("DB error"));
    const { res } = await call();
    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
  });
});

// ==================== 不支持的方法 ====================

describe("不支持的方法", () => {
  it("PUT 返回 405 并声明 Allow 头", async () => {
    const { res } = await call({ method: "PUT" });
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toEqual(["GET", "DELETE", "PATCH"]);
  });
});
