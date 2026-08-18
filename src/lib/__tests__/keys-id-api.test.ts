/**
 * API Key 单个操作 API（pages/api/admin/keys/[id].ts）单元测试
 *
 * 覆盖（2026-08-18 审计回归）：
 * - A6 DELETE 级联清理 daily_stats（此前只删 requestLogs，daily_stats 残留导致
 *   仪表盘历史统计与日志页数据矛盾）
 * - PUT status 枚举：expired 合法（与 import.ts VALID_KEY_STATUSES 白名单一致），
 *   白名单外值 400
 *
 * Mock 外部依赖：@/lib/prisma、@/lib/admin-auth、@/lib/admin-security、@/lib/admin-rate-limit
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";

// ==================== Mocks ====================

const mocks = vi.hoisted(() => ({
  apiKeyFindFirst: vi.fn(),
  apiKeyUpdate: vi.fn(),
  apiKeyDelete: vi.fn(),
  requestLogsDeleteMany: vi.fn(),
  dailyStatsDeleteMany: vi.fn(),
  auditCreate: vi.fn(),
  getAdmin: vi.fn(),
  getAuditAdminId: vi.fn(),
  checkCsrfOrigin: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(async () => ({
    apiKeys: {
      findFirst: mocks.apiKeyFindFirst,
      update: mocks.apiKeyUpdate,
      delete: mocks.apiKeyDelete,
    },
    requestLogs: {
      deleteMany: mocks.requestLogsDeleteMany,
    },
    dailyStats: {
      deleteMany: mocks.dailyStatsDeleteMany,
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

vi.mock("@/lib/admin-security", () => ({
  checkCsrfOrigin: mocks.checkCsrfOrigin,
}));

vi.mock("@/lib/admin-rate-limit", () => ({
  checkAdminRateLimit: mocks.checkRateLimit,
}));

// ==================== Helpers ====================

import handler from "../../../pages/api/admin/keys/[id]";

function makeReq(overrides: any = {}): NextApiRequest {
  return {
    method: "GET",
    headers: { host: "example.com" },
    body: {},
    cookies: {},
    query: { id: "k1" },
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

async function call(method: string, body: any = {}, query: any = { id: "k1" }) {
  const req = makeReq({ method, body, query });
  const res = makeRes();
  await handler(req, res);
  return { req, res: res as any };
}

const ADMIN = { adminId: "admin-1", username: "admin" };
const EXISTING_KEY = {
  id: "k1",
  key: "sk-test-1234567890",
  name: "测试 Key",
  status: "active",
  usedTokens: 0,
  resetPeriod: "monthly",
  expiresAt: null,
  updatedAt: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAdmin.mockResolvedValue(ADMIN);
  mocks.getAuditAdminId.mockReturnValue("env-admin");
  mocks.checkCsrfOrigin.mockReturnValue(true);
  mocks.checkRateLimit.mockResolvedValue(true);
  mocks.apiKeyFindFirst.mockResolvedValue(EXISTING_KEY);
  mocks.apiKeyUpdate.mockResolvedValue({ ...EXISTING_KEY, status: "active" });
  mocks.apiKeyDelete.mockResolvedValue({});
  mocks.requestLogsDeleteMany.mockResolvedValue({ count: 3 });
  mocks.dailyStatsDeleteMany.mockResolvedValue({ count: 2 });
  mocks.auditCreate.mockResolvedValue({});
});

// ==================== DELETE — 级联清理 ====================

describe("DELETE /api/admin/keys/[id]", () => {
  it("未认证返回 401", async () => {
    mocks.getAdmin.mockResolvedValue(null);
    const { res } = await call("DELETE");
    expect(res.statusCode).toBe(401);
  });

  it("Key 不存在返回 404 且不触发任何删除", async () => {
    mocks.apiKeyFindFirst.mockResolvedValue(null);
    const { res } = await call("DELETE");
    expect(res.statusCode).toBe(404);
    expect(mocks.requestLogsDeleteMany).not.toHaveBeenCalled();
    expect(mocks.dailyStatsDeleteMany).not.toHaveBeenCalled();
    expect(mocks.apiKeyDelete).not.toHaveBeenCalled();
  });

  it("删除时级联清理 daily_stats（A6 回归：此前残留导致统计与日志矛盾）", async () => {
    const { res } = await call("DELETE");
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    // 级联顺序：requestLogs → dailyStats → apiKeys
    expect(mocks.requestLogsDeleteMany).toHaveBeenCalledWith({ where: { keyId: "k1" } });
    expect(mocks.dailyStatsDeleteMany).toHaveBeenCalledWith({ where: { keyId: "k1" } });
    expect(mocks.apiKeyDelete).toHaveBeenCalledWith({ where: { id: "k1" } });
  });

  it("删除时写入审计日志（含删除日志数量）", async () => {
    const { res } = await call("DELETE");
    expect(res.statusCode).toBe(200);
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "delete_api_key",
          adminId: "env-admin",
          detail: expect.stringContaining('"deletedLogs":3'),
        }),
      })
    );
  });
});

// ==================== PUT — status 枚举 ====================

describe("PUT /api/admin/keys/[id]", () => {
  it("status=expired 合法并写入（与 import 白名单一致的枚举）", async () => {
    mocks.apiKeyUpdate.mockResolvedValue({ ...EXISTING_KEY, status: "expired" });
    const { res } = await call("PUT", { status: "expired" });
    expect(res.statusCode).toBe(200);
    expect(mocks.apiKeyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "k1" },
        data: expect.objectContaining({ status: "expired" }),
      })
    );
  });

  it("status 白名单外值返回 400", async () => {
    const { res } = await call("PUT", { status: "banned" });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.message).toContain("status");
    expect(mocks.apiKeyUpdate).not.toHaveBeenCalled();
  });
});