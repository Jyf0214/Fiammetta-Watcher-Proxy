/**
 * 平台模型可用性测试 API（pages/api/admin/platforms/[id]/test-model.ts）单元测试
 *
 * 覆盖（2026-08-18 审计 A10 回归）：
 * - enabled=false 的已禁用密钥不参与测试（此前全部密钥逐个真实请求测试，
 *   禁用密钥可能已被上游吊销，失败项混入误导平台可用性判断）
 * - 全部密钥禁用时返回 400 无可用密钥提示，且不发起任何上游请求
 * - 字符串数组旧格式不受影响（全部测试）
 *
 * Mock 外部依赖：@/lib/prisma、@/lib/admin-auth、@/lib/admin-security、
 * @/lib/admin-rate-limit、@/lib/upstream-proxy、全局 fetch
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";

// ==================== Mocks ====================

const mocks = vi.hoisted(() => ({
  platformFindFirst: vi.fn(),
  getAdmin: vi.fn(),
  checkCsrfOrigin: vi.fn(),
  isSafeUrl: vi.fn(),
  checkRateLimit: vi.fn(),
  getUpstreamProxy: vi.fn(),
  markProxyFailure: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(async () => ({
    platforms: {
      findFirst: mocks.platformFindFirst,
    },
  })),
}));

vi.mock("@/lib/admin-auth", () => ({
  getAdminFromRequest: mocks.getAdmin,
}));

vi.mock("@/lib/admin-security", () => ({
  checkCsrfOrigin: mocks.checkCsrfOrigin,
  isSafeUrl: mocks.isSafeUrl,
}));

vi.mock("@/lib/admin-rate-limit", () => ({
  checkAdminRateLimit: mocks.checkRateLimit,
}));

vi.mock("@/lib/upstream-proxy", () => ({
  getUpstreamProxy: mocks.getUpstreamProxy,
  markProxyFailure: mocks.markProxyFailure,
}));

// ==================== Helpers ====================

import handler from "../../../pages/api/admin/platforms/[id]/test-model";

function makeReq(body: any = {}): NextApiRequest {
  return {
    method: "POST",
    headers: { host: "example.com" },
    body,
    cookies: {},
    query: { id: "p1" },
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

async function call(body: any = { modelId: "gpt-4o" }) {
  const req = makeReq(body);
  const res = makeRes();
  await handler(req, res);
  return { req, res: res as any };
}

const ADMIN = { adminId: "admin-1", username: "admin" };
const PLATFORM = {
  id: "p1",
  name: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  apiKeys: "[]",
};

/** 构造上游 ok 的伪 Response（ok 分支消费 body.cancel） */
function okResponse() {
  return {
    ok: true,
    status: 200,
    body: { cancel: vi.fn(async () => {}) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAdmin.mockResolvedValue(ADMIN);
  mocks.checkCsrfOrigin.mockReturnValue(true);
  mocks.isSafeUrl.mockResolvedValue({ safe: true, reason: "" });
  mocks.checkRateLimit.mockResolvedValue(true);
  mocks.getUpstreamProxy.mockResolvedValue({ url: null, dispatcher: null });
  mocks.markProxyFailure.mockResolvedValue(undefined);
  mocks.platformFindFirst.mockResolvedValue({ ...PLATFORM });
  mocks.fetch.mockResolvedValue(okResponse());
  vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ==================== 密钥过滤 ====================

describe("POST /api/admin/platforms/:id/test-model", () => {
  it("未认证返回 401", async () => {
    mocks.getAdmin.mockResolvedValue(null);
    const { res } = await call();
    expect(res.statusCode).toBe(401);
  });

  it("enabled=false 的已禁用密钥不参与测试（A10 回归）", async () => {
    mocks.platformFindFirst.mockResolvedValue({
      ...PLATFORM,
      apiKeys: JSON.stringify([
        { name: "禁用密钥", key: "sk-disabled-1", enabled: false },
        { name: "可用密钥", key: "sk-active-1", enabled: true },
      ]),
    });
    const { res } = await call();
    expect(res.statusCode).toBe(200);
    // 只对可用密钥发起一次真实请求
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const fetchCall = mocks.fetch.mock.calls[0];
    expect(fetchCall[0]).toBe("https://api.openai.com/v1/chat/completions");
    expect(fetchCall[1].headers.Authorization).toBe("Bearer sk-active-1");
    // 结果只包含可用密钥
    const results = res.body.data as Array<{ name: string; keyMasked: string }>;
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("可用密钥");
  });

  it("全部密钥已禁用时返回 400 且不发起任何上游请求", async () => {
    mocks.platformFindFirst.mockResolvedValue({
      ...PLATFORM,
      apiKeys: JSON.stringify([
        { name: "禁用1", key: "sk-disabled-1", enabled: false },
        { name: "禁用2", key: "sk-disabled-2", enabled: false },
      ]),
    });
    const { res } = await call();
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("可用密钥");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("字符串数组旧格式全部密钥参与测试", async () => {
    mocks.platformFindFirst.mockResolvedValue({
      ...PLATFORM,
      apiKeys: JSON.stringify(["sk-plain-1", "sk-plain-2"]),
    });
    const { res } = await call();
    expect(res.statusCode).toBe(200);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(res.body.data).toHaveLength(2);
  });
});