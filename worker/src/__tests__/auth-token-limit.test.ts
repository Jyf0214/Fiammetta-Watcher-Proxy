/**
 * validateApiKey Token 额度（tokenLimit）运行时检查测试
 *
 * tokenLimit 此前仅为管理后台字段，运行时从不检查（与套餐同性质的假功能）。
 * 本次在 auth.ts 增加检查：usedTokens 达到 tokenLimit 后返回 429。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateApiKey } from "../auth";
import type { WorkerEnv } from "../config";

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(),
}));

import { createDb } from "@/lib/prisma";

function makeKey(overrides: Record<string, unknown> = {}) {
  return {
    id: "key-id",
    key: "sk-test",
    name: "test",
    usedTokens: 0,
    tokenLimit: null,
    rpmLimit: null,
    tpmLimit: null,
    callLimit: null,
    callUsed: 0,
    resetPeriod: "monthly",
    status: "active",
    expiresAt: null,
    updatedAt: 0,
    ...overrides,
  };
}

function mockFindFirst(record: unknown) {
  vi.mocked(createDb).mockResolvedValue({
    apiKeys: { findFirst: vi.fn(async () => record) },
  } as never);
}

const env = { DB_TYPE: "d1" } as WorkerEnv;

beforeEach(() => {
  vi.mocked(createDb).mockReset();
});

describe("validateApiKey tokenLimit 检查", () => {
  it("tokenLimit 为 null 时不限制（即使 usedTokens 很大）", async () => {
    mockFindFirst(makeKey({ usedTokens: 99999, tokenLimit: null }));
    const result = await validateApiKey("Bearer sk-test", {} as D1Database, env);
    expect("apiKey" in result).toBe(true);
  });

  it("tokenLimit 为 0 时不限制（0 表示不设限制）", async () => {
    mockFindFirst(makeKey({ usedTokens: 99999, tokenLimit: 0 }));
    const result = await validateApiKey("Bearer sk-test", {} as D1Database, env);
    expect("apiKey" in result).toBe(true);
  });

  it("usedTokens 未达 tokenLimit 时放行", async () => {
    mockFindFirst(makeKey({ usedTokens: 90, tokenLimit: 100 }));
    const result = await validateApiKey("Bearer sk-test", {} as D1Database, env);
    expect("apiKey" in result).toBe(true);
  });

  it("usedTokens 恰好达到 tokenLimit 时返回 429", async () => {
    mockFindFirst(makeKey({ usedTokens: 100, tokenLimit: 100 }));
    const result = await validateApiKey("Bearer sk-test", {} as D1Database, env);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(429);
      const body = (await result.error.json()) as { error?: { message?: string } };
      expect(body.error?.message).toContain("Token 额度已达上限");
    }
  });

  it("usedTokens 超过 tokenLimit 时返回 429", async () => {
    mockFindFirst(makeKey({ usedTokens: 150, tokenLimit: 100 }));
    const result = await validateApiKey("Bearer sk-test", {} as D1Database, env);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(429);
    }
  });
});