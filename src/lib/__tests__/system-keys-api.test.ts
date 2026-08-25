/**
 * 系统 API Key 管理 API（pages/api/admin/system-keys.ts）单元测试
 *
 * 覆盖：
 * - GET 列表（认证、密钥掩码——不泄露完整密钥、数据库错误）
 * - POST 创建（认证、名称校验、成功创建返回完整密钥且写入审计日志、
 *   审计失败返回 500 且 Key 不落库、审计 ip 取自 getClientIp 结果）
 * - 不支持方法 405
 *
 * Mock 外部依赖：@/lib/prisma、@/lib/admin-auth、@/lib/admin-security、
 * pages/api/admin/auth（仅 getClientIp）
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
  getClientIp: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(async () => ({
    systemApiKeys: {
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

vi.mock("@/lib/admin-security", () => ({
  checkCsrfOrigin: vi.fn(() => true),
}));

// system-keys.ts 从 ./auth 导入 getClientIp 记录审计来源 IP，整体 mock 隔离其内部依赖
vi.mock("../../../pages/api/admin/auth", () => ({
  getClientIp: mocks.getClientIp,
}));

// ==================== Helpers ====================

import handler from "../../../pages/api/admin/system-keys";

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

const ADMIN = { adminId: "admin-1", username: "admin" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAdmin.mockResolvedValue(ADMIN);
  mocks.getAuditAdminId.mockReturnValue("env-admin");
  mocks.getClientIp.mockReturnValue(null);
  mocks.findMany.mockResolvedValue([]);
  mocks.create.mockResolvedValue({});
  mocks.auditCreate.mockResolvedValue({});
});

// ==================== GET — 列表（掩码） ====================

describe("GET /api/admin/system-keys", () => {
  it("未认证返回 401", async () => {
    mocks.getAdmin.mockResolvedValue(null);
    const { res } = await call();
    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("列表返回掩码，不泄露完整密钥", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "sys-001",
        name: "开发 Key",
        key: "sk-sys-abcdef1234567890abcdef1234",
        enabled: true,
        createdAt: 1000,
        updatedAt: 1000,
      },
      { id: "sys-002", name: "短 Key", key: "short", enabled: true, createdAt: 2000, updatedAt: 2000 },
    ]);

    const { res } = await call();
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.total).toBe(2);
    // 长密钥掩码：前 8 位 + "..." + 后 4 位
    expect(res.body.data[0].key).toBe("sk-sys-a...1234");
    expect(res.body.data[0].key).not.toBe("sk-sys-abcdef1234567890abcdef1234");
    // 响应序列化后不得出现完整密钥
    expect(JSON.stringify(res.body)).not.toContain("sk-sys-abcdef1234567890abcdef1234");
    // 短密钥全掩
    expect(res.body.data[1].key).toBe("***");
    // 其他字段不受影响
    expect(res.body.data[0].id).toBe("sys-001");
    expect(res.body.data[0].enabled).toBe(true);
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
      {
        id: "sys-001",
        name: "开发 Key",
        key: "sk-sys-abcdef1234567890abcdef1234",
        enabled: true,
        createdAt: 1000,
        updatedAt: 1000,
      },
    ]);

    const { res } = await call({ query: { limit: "10", offset: "2" } });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(false);
    expect(res.body.data.total).toBe(3);
    expect(res.body.data.items).toHaveLength(1);
    // 分页模式同样掩码
    expect(res.body.data.items[0].key).toBe("sk-sys-a...1234");
    expect(JSON.stringify(res.body)).not.toContain("sk-sys-abcdef1234567890abcdef1234");
    // findMany 携带 take/skip
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10, skip: 2, orderBy: { createdAt: "desc" } })
    );
  });

  it("limit 钳制到 1~500，非法 limit 取默认 50", async () => {
    mocks.count.mockResolvedValue(0);
    mocks.findMany.mockResolvedValue([]);

    await call({ query: { limit: "99999" } });
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 500 }));

    await call({ query: { limit: "0" } });
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1 }));

    await call({ query: { limit: "abc", offset: "-5" } });
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50, skip: 0 }));
  });

  it("不带分页参数时保持原数组形态（向后兼容）", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "sys-001",
        name: "开发 Key",
        key: "sk-sys-abcdef1234567890abcdef1234",
        enabled: true,
        createdAt: 1000,
        updatedAt: 1000,
      },
    ]);

    const { res } = await call();
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.total).toBe(1);
    // 分页模式下不会调用 count
    expect(mocks.count).not.toHaveBeenCalled();
  });
});

// ==================== POST — 创建 ====================

describe("POST /api/admin/system-keys", () => {
  const validBody = { name: "Test System Key" };

  it("未认证返回 401", async () => {
    mocks.getAdmin.mockResolvedValue(null);
    const { res } = await call({ method: "POST", body: validBody });
    expect(res.statusCode).toBe(401);
  });

  it("名称为空返回 400", async () => {
    const { res } = await call({ method: "POST", body: { name: "  " } });
    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("名称超 100 字符返回 400", async () => {
    const { res } = await call({ method: "POST", body: { name: "x".repeat(101) } });
    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("成功创建返回完整密钥（仅此一次），并写入审计日志", async () => {
    const fullKey = "sk-sys-abcdef1234567890abcdef1234";
    mocks.create.mockResolvedValue({
      id: "sys-001",
      key: fullKey,
      name: "Test System Key",
      enabled: true,
      createdAt: 1000,
      updatedAt: 1000,
    });

    const { res } = await call({ method: "POST", body: validBody });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    // 创建接口返回完整明文（仅此一次），非掩码
    expect(res.body.data.key).toBe(fullKey);
    expect(res.body.message).toContain("仅显示一次");

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "Test System Key",
          enabled: true,
        }),
      })
    );
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "create_system_key",
          adminId: "env-admin",
        }),
      })
    );
  });

  it("审计写入失败返回 500 且 Key 不落库（审计先于写入）", async () => {
    mocks.auditCreate.mockRejectedValue(new Error("audit write failed"));

    const { res } = await call({ method: "POST", body: validBody });
    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
    // 审计先于主表写入：审计失败时 create 不得被调用
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("审计日志 ip 记录为 getClientIp(req) 的结果", async () => {
    mocks.getClientIp.mockReturnValue("203.0.113.66");

    const { res } = await call({ method: "POST", body: validBody });
    expect(res.statusCode).toBe(200);
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ip: "203.0.113.66" }),
      })
    );
  });
});

// ==================== 不支持的方法 ====================

describe("不支持的方法", () => {
  it("PUT 返回 405 并声明 Allow 头", async () => {
    const { res } = await call({ method: "PUT" });
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toEqual(["GET", "POST"]);
  });
});