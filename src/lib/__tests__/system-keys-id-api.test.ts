/**
 * 系统 API Key 单个操作 API（pages/api/admin/system-keys/[id].ts）单元测试
 *
 * 覆盖：
 * - GET 单个 Key 明文（认证、404、返回明文而非掩码）
 * - PATCH 启用/禁用（config.ts 不变量：审计先于写入，审计失败返回 500 且不落库）
 * - DELETE 删除（config.ts 不变量：审计先于删除，审计失败返回 500 且不删除）
 * - 不支持方法 405
 *
 * Mock 外部依赖：@/lib/prisma、@/lib/admin-auth、@/lib/admin-security
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";

// ==================== Mocks ====================

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  auditCreate: vi.fn(),
  getAdmin: vi.fn(),
  getAuditAdminId: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(async () => ({
    systemApiKeys: {
      findFirst: mocks.findFirst,
      update: mocks.update,
      delete: mocks.delete,
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
  checkCsrfOrigin: vi.fn(() => true),
}));

vi.mock("@/lib/admin-rate-limit", () => ({
  checkAdminRateLimit: mocks.checkRateLimit,
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
  mocks.checkRateLimit.mockResolvedValue(true);
  mocks.findFirst.mockResolvedValue(null);
  mocks.update.mockResolvedValue({});
  mocks.delete.mockResolvedValue({});
  mocks.auditCreate.mockResolvedValue({});
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

// ==================== PATCH — 启用/禁用 ====================

describe("PATCH /api/admin/system-keys/[id]", () => {
  const EXISTING = { id: "sys-001", name: "开发 Key" };

  it("未认证返回 401", async () => {
    mocks.getAdmin.mockResolvedValue(null);
    const { res } = await call({ method: "PATCH", body: { enabled: false } });
    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("enabled 非布尔返回 400", async () => {
    const { res } = await call({ method: "PATCH", body: { enabled: "yes" } });
    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("Key 不存在返回 404", async () => {
    mocks.findFirst.mockResolvedValue(null);
    const { res } = await call({ method: "PATCH", body: { enabled: true } });
    expect(res.statusCode).toBe(404);
    expect(res.body.success).toBe(false);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("成功更新 enabled 并写入审计日志（update_system_key）", async () => {
    mocks.findFirst.mockResolvedValue(EXISTING);

    const { res } = await call({ method: "PATCH", body: { enabled: false } });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toContain("禁用");

    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "sys-001" },
      data: expect.objectContaining({ enabled: false }),
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "update_system_key",
          adminId: "env-admin",
          detail: expect.stringContaining("sys-001"),
        }),
      })
    );
  });

  it("启用成功时消息含「启用」且审计 detail 含 enabled 状态", async () => {
    mocks.findFirst.mockResolvedValue(EXISTING);

    const { res } = await call({ method: "PATCH", body: { enabled: true } });
    expect(res.statusCode).toBe(200);
    expect(res.body.message).toContain("启用");
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "update_system_key",
          detail: JSON.stringify({ target: "sys-001", name: "开发 Key", enabled: true }),
        }),
      })
    );
  });

  it("审计日志写入失败返回 500 且更新未执行（审计先于写入）", async () => {
    mocks.findFirst.mockResolvedValue(EXISTING);
    mocks.auditCreate.mockRejectedValue(new Error("audit db down"));

    const { res } = await call({ method: "PATCH", body: { enabled: true } });
    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("数据库错误返回 500", async () => {
    mocks.findFirst.mockResolvedValue(EXISTING);
    mocks.update.mockRejectedValue(new Error("DB error"));
    const { res } = await call({ method: "PATCH", body: { enabled: true } });
    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
  });
});

// ==================== DELETE — 删除系统 Key ====================

describe("DELETE /api/admin/system-keys/[id]", () => {
  const EXISTING = { id: "sys-001", name: "开发 Key" };

  it("未认证返回 401", async () => {
    mocks.getAdmin.mockResolvedValue(null);
    const { res } = await call({ method: "DELETE" });
    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("Key 不存在返回 404", async () => {
    mocks.findFirst.mockResolvedValue(null);
    const { res } = await call({ method: "DELETE" });
    expect(res.statusCode).toBe(404);
    expect(res.body.success).toBe(false);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it("成功删除并写入审计日志，且审计先于删除执行", async () => {
    mocks.findFirst.mockResolvedValue(EXISTING);

    const { res } = await call({ method: "DELETE" });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);

    expect(mocks.delete).toHaveBeenCalledWith({ where: { id: "sys-001" } });
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "delete_system_key",
          adminId: "env-admin",
          detail: JSON.stringify({ target: "sys-001", name: "开发 Key" }),
        }),
      })
    );
    // config.ts 不变量：审计先于主操作
    expect(mocks.auditCreate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.delete.mock.invocationCallOrder[0]
    );
  });

  it("审计日志写入失败返回 500 且删除未执行（审计先于写入）", async () => {
    mocks.findFirst.mockResolvedValue(EXISTING);
    mocks.auditCreate.mockRejectedValue(new Error("audit db down"));

    const { res } = await call({ method: "DELETE" });
    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
    expect(mocks.delete).not.toHaveBeenCalled();
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
