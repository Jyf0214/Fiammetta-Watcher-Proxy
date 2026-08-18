/**
 * 平台管理 API（pages/api/admin/platforms.ts）单元测试
 *
 * 覆盖：
 * - GET 列表（认证、数据返回）
 * - POST 创建（输入校验、SSRF 防护、成功创建、审计日志）
 * - 未认证 401、不支持方法 405
 *
 * Mock 外部依赖：@/lib/prisma、@/lib/admin-auth、@/lib/admin-rate-limit、@/lib/admin-security
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";

// ==================== Mocks ====================
// vi.hoisted 确保 vi.mock 工厂执行时变量已初始化（工厂调用被提升到文件顶部）

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  findMany: vi.fn(),
  auditCreate: vi.fn(),
  getAdmin: vi.fn(),
  getAuditAdminId: vi.fn(),
  checkRateLimit: vi.fn(),
  isSafeUrl: vi.fn(),
  checkCsrfOrigin: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(async () => ({
    platforms: {
      findMany: mocks.findMany,
      create: mocks.create,
    },
    auditLogs: {
      create: mocks.auditCreate,
    },
  })),
}));

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    throw new Error("no Cloudflare context");
  },
}));

vi.mock("@/lib/admin-auth", () => ({
  getAdminFromRequest: mocks.getAdmin,
  getAuditAdminId: mocks.getAuditAdminId,
}));

vi.mock("@/lib/admin-rate-limit", () => ({
  checkAdminRateLimit: mocks.checkRateLimit,
}));

vi.mock("@/lib/admin-security", () => ({
  isSafeUrl: mocks.isSafeUrl,
  checkCsrfOrigin: mocks.checkCsrfOrigin,
}));

vi.mock("@/lib/key-status", () => ({
  readPlatformKeyStatus: vi.fn(async () => ({})),
}));

// ==================== Helpers ====================

import handler from "../../../pages/api/admin/platforms";

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
  mocks.checkCsrfOrigin.mockReturnValue(true);
  mocks.isSafeUrl.mockResolvedValue({ safe: true, reason: "" });
  mocks.getAuditAdminId.mockReturnValue("env-admin");
  mocks.findMany.mockResolvedValue([]);
  mocks.create.mockResolvedValue({ id: "mock-id", name: "", baseUrl: "", apiKeys: "[]", type: "openai", enabled: true, priority: 0, weight: 1, rpmLimit: null, tpmLimit: null, status: "healthy", failCount: 0, lastFailAt: null, cooldownEnd: null, forwardHeaders: "[]", injectStreamOptions: true, whitelisted: false, createdAt: 0, updatedAt: 0 });
  mocks.auditCreate.mockResolvedValue({});
});

// ==================== GET ====================

describe("GET /api/admin/platforms", () => {
  it("未认证返回 401", async () => {
    mocks.getAdmin.mockResolvedValue(null);
    const { res } = await call();
    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("认证成功返回平台列表", async () => {
    const mockPlatforms = [
      { id: "p1", name: "Platform1", enabled: true, priority: 10 },
      { id: "p2", name: "Platform2", enabled: false, priority: 0 },
    ];
    mocks.findMany.mockResolvedValue(mockPlatforms);

    const { res } = await call();
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(2);
    // 每个平台应包含 keyStatuses 字段
    expect(res.body.data[0].keyStatuses).toBeDefined();
  });

  it("数据库错误返回 500", async () => {
    mocks.findMany.mockRejectedValue(new Error("DB error"));
    const { res } = await call();
    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
  });
});

// ==================== POST ====================

describe("POST /api/admin/platforms", () => {
  const validBody = {
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKeys: JSON.stringify([{ name: "main", key: "sk-test123" }]),
  };

  it("未认证返回 401", async () => {
    mocks.getAdmin.mockResolvedValue(null);
    const { res } = await call({ method: "POST", body: validBody });
    expect(res.statusCode).toBe(401);
  });

  it("CSRF 校验失败时不继续", async () => {
    mocks.checkCsrfOrigin.mockReturnValue(false);
    await call({ method: "POST", body: validBody });
    // checkCsrfOrigin mock 返回 false 时 handler 直接 return（已由 checkCsrfOrigin 内部响应）
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("名称为空返回 400", async () => {
    const { res } = await call({
      method: "POST",
      body: { ...validBody, name: "" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("平台名称");
  });

  it("baseUrl 为空返回 400", async () => {
    const { res } = await call({
      method: "POST",
      body: { ...validBody, baseUrl: "" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("URL");
  });

  it("apiKeys 为空返回 400", async () => {
    const { res } = await call({
      method: "POST",
      body: { ...validBody, apiKeys: "" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("密钥");
  });

  it("SSRF 不安全 URL 返回 400", async () => {
    mocks.isSafeUrl.mockResolvedValue({ safe: false, reason: "private IP" });
    const { res } = await call({ method: "POST", body: validBody });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("private IP");
  });

  it("有效输入成功创建平台", async () => {
    const { res } = await call({ method: "POST", body: validBody });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.name).toBe("OpenAI");
    expect(res.body.data.enabled).toBe(true);
    expect(res.body.data.status).toBe("healthy");

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          type: "openai",
          enabled: true,
          status: "healthy",
        }),
      })
    );
  });

  it("平台名含 HTML 特殊字符时原样存库（不做 escapeHtml 双重转义）", async () => {
    // 回归：此前 escapeHtml(name.trim()) 存库，React 渲染自动转义后显示
    // "AT&amp;T"，再次保存对已转义文本再转义 → &amp;amp; 不可逆累积损坏
    const name = 'AT&T <Partner> "Quote" & Co';
    const { res } = await call({
      method: "POST",
      body: { ...validBody, name },
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name }),
      })
    );
    expect(res.body.data.name).toBe(name);
  });

  it("平台名超过 100 字符返回 400", async () => {
    const { res } = await call({
      method: "POST",
      body: { ...validBody, name: "x".repeat(101) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("100");
  });

  it("创建时写入审计日志", async () => {
    await call({ method: "POST", body: validBody });
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "create_platform",
          adminId: "env-admin",
        }),
      })
    );
  });

  it("apiKeys 支持字符串数组格式", async () => {
    const { res } = await call({
      method: "POST",
      body: { ...validBody, apiKeys: JSON.stringify(["sk-plain-key"]) },
    });
    expect(res.statusCode).toBe(200);
    const createCall = mocks.create.mock.calls[0][0];
    const parsed = JSON.parse(createCall.data.apiKeys);
    expect(parsed[0].key).toBe("sk-plain-key");
    expect(parsed[0].name).toBeDefined();
  });

  it("apiKeys JSON 格式错误返回 400", async () => {
    const { res } = await call({
      method: "POST",
      body: { ...validBody, apiKeys: "not-json" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("JSON");
  });

  it("无效平台类型返回 400", async () => {
    const { res } = await call({
      method: "POST",
      body: { ...validBody, type: "invalid" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("平台类型");
  });

  it("权重非正整数返回 400", async () => {
    const { res } = await call({
      method: "POST",
      body: { ...validBody, weight: -1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("权重");
  });
});

// ==================== 其他方法 ====================

describe("不支持的方法", () => {
  it("PUT 返回 405", async () => {
    const { res } = await call({ method: "PUT" });
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toEqual(["GET", "POST"]);
  });
});
