/**
 * handleV1Route 认证顺序测试
 *
 * 回归保障：/v1/models 与 /v1/models/:model 必须位于 API Key 验证之后——
 * 未认证时返回 401，不得匿名返回模型清单/平台名（历史漏洞：认证前直接
 * 返回列表，可匿名枚举模型并外带盲 SSRF 探测结果）。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleV1Route } from "../v1-route";

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(),
}));

vi.mock("../router", () => ({
  refreshCache: vi.fn(async () => {}),
  getPlatformCache: vi.fn(() => []),
  getPlatformModelCache: vi.fn(() => new Map()),
}));

import { createDb } from "@/lib/prisma";

function makeApiKey() {
  return {
    id: "key-id",
    key: "sk-test",
    name: "test",
    usedTokens: 0n,
    rpmLimit: null,
    tpmLimit: null,
    callLimit: null,
    tokenLimit: null,
    callUsed: 0,
    resetPeriod: "monthly",
    status: "active",
    expiresAt: null,
    updatedAt: 0,
  };
}

const env = { DB: {} as D1Database, KV: {} as KVNamespace, DB_TYPE: "d1" };
const ctx = {} as ExecutionContext;

beforeEach(() => {
  vi.mocked(createDb).mockReset();
});

describe("handleV1Route /v1/models 认证顺序", () => {
  it("GET /v1/models 无 API Key 返回 401", async () => {
    vi.mocked(createDb).mockResolvedValue({
      apiKeys: { findFirst: vi.fn(async () => null) },
    } as never);
    const res = await handleV1Route(new Request("http://localhost/v1/models"), env, ctx);
    expect(res.status).toBe(401);
  });

  it("GET /v1/models/:model 无 API Key 返回 401", async () => {
    vi.mocked(createDb).mockResolvedValue({
      apiKeys: { findFirst: vi.fn(async () => null) },
    } as never);
    const res = await handleV1Route(new Request("http://localhost/v1/models/gpt-4o"), env, ctx);
    expect(res.status).toBe(401);
  });

  it("GET /v1/models 携带有效 API Key 返回 200 模型列表", async () => {
    vi.mocked(createDb).mockResolvedValue({
      apiKeys: { findFirst: vi.fn(async () => makeApiKey()) },
    } as never);
    const res = await handleV1Route(
      new Request("http://localhost/v1/models", {
        headers: { Authorization: "Bearer sk-test" },
      }),
      env,
      ctx
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: unknown[] };
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("POST /v1/chat/completions 无 API Key 返回 401（其他端点不受影响）", async () => {
    vi.mocked(createDb).mockResolvedValue({
      apiKeys: { findFirst: vi.fn(async () => null) },
    } as never);
    const res = await handleV1Route(
      new Request("http://localhost/v1/chat/completions", { method: "POST" }),
      env,
      ctx
    );
    expect(res.status).toBe(401);
  });
});