/**
 * 审计日志 API（pages/api/admin/audit.ts）单元测试
 *
 * 覆盖：
 * - GET 列表（认证、分页、username 直接回退为 adminId，不依赖 admins 表）
 *
 * Mock 外部依赖：@/lib/prisma、@/lib/admin-auth
 * 注：createDb mock 不提供 admins 属性——若代码仍查询 admins 表会抛 TypeError，
 * 从而隐式验证 adminMap 查询已移除。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";

// ==================== Mocks ====================

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  count: vi.fn(),
  getAdmin: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(async () => ({
    auditLogs: {
      findMany: mocks.findMany,
      count: mocks.count,
    },
  })),
}));

vi.mock("@/lib/admin-auth", () => ({
  getAdminFromRequest: mocks.getAdmin,
}));

// ==================== Helpers ====================

import handler from "../../../pages/api/admin/audit";

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

async function call(reqOverrides: any = {}) {
  const req = makeReq(reqOverrides);
  const res = makeRes();
  await handler(req, res);
  return { req, res: res as any };
}

const ADMIN = { adminId: "env-admin", username: "admin" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAdmin.mockResolvedValue(ADMIN);
  mocks.findMany.mockResolvedValue([]);
  mocks.count.mockResolvedValue(0);
});

// ==================== GET ====================

describe("GET /api/admin/audit", () => {
  it("未认证返回 401", async () => {
    mocks.getAdmin.mockResolvedValue(null);
    const { res } = await call();
    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("username 直接回退为 adminId，不查询 admins 表", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "log-1", adminId: "env-admin", action: "login", detail: "{}", ip: null, createdAt: 1000 },
      { id: "log-2", adminId: null, action: "create_system_key", detail: "{}", ip: null, createdAt: 2000 },
      { id: "log-3", adminId: "sys-key-id", action: "delete_system_key", detail: "{}", ip: null, createdAt: 3000 },
    ]);
    mocks.count.mockResolvedValue(3);

    const { res } = await call();
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.total).toBe(3);
    expect(res.body.data.items[0].username).toBe("env-admin");
    expect(res.body.data.items[1].username).toBeNull();
    expect(res.body.data.items[2].username).toBe("sys-key-id");
  });

  it("分页参数生效且 pageSize 上限为 100", async () => {
    mocks.count.mockResolvedValue(150);
    const { res } = await call({ query: { page: "2", pageSize: "500" } });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.page).toBe(2);
    expect(res.body.data.pageSize).toBe(100);
    expect(res.body.data.totalPages).toBe(2);
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 100, take: 100 })
    );
  });

  it("数据库错误返回 500", async () => {
    mocks.findMany.mockRejectedValue(new Error("DB error"));
    const { res } = await call();
    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
  });
});
