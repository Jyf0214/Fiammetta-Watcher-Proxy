/**
 * validateApiKey 认证头兼容测试
 *
 * 此前非 "Bearer " 前缀的头值一律置空：Anthropic 官方 SDK 只发 x-api-key
 * （无 Bearer 前缀的裸密钥），经三端提取函数透传后全部被 401 拒绝，
 * 与「兼容 Anthropic 客户端」的注释承诺相反。修复后裸密钥原样参与查库校验。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateApiKey, invalidateApiKeyCache, resetCallLimitCounters } from "../auth";
import type { WorkerEnv } from "../config";

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(),
}));

import { createDb } from "@/lib/prisma";

function makeKey(overrides: Record<string, unknown> = {}) {
  return {
    id: "key-id",
    key: "sk-ant-bare",
    name: "anthropic-client",
    usedTokens: 0n,
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
    apiKeys: { findFirst: vi.fn(async ({ where }: { where?: { key?: string } }) => {
      if (record && where?.key === (record as { key: string }).key) return record;
      return null;
    }) },
  } as never);
}

const env = { DB_TYPE: "d1" } as WorkerEnv;

beforeEach(() => {
  vi.mocked(createDb).mockReset();
  invalidateApiKeyCache();
  resetCallLimitCounters();
});

describe("validateApiKey 认证头兼容", () => {
  it("裸密钥（Anthropic SDK x-api-key 形态）可通过认证", async () => {
    mockFindFirst(makeKey());
    const result = await validateApiKey("sk-ant-bare", {} as D1Database, env);
    expect("apiKey" in result && result.apiKey.key === "sk-ant-bare").toBe(true);
  });

  it("Bearer 前缀仍正常剥离并认证", async () => {
    mockFindFirst(makeKey());
    const result = await validateApiKey("Bearer sk-ant-bare", {} as D1Database, env);
    expect("apiKey" in result).toBe(true);
  });

  it("不存在的裸密钥返回 401（非法值自然失败，不引入额外风险）", async () => {
    mockFindFirst(makeKey());
    const result = await validateApiKey("sk-unknown", {} as D1Database, env);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(401);
    }
  });

  it("空串头值返回 401 缺少 API Key", async () => {
    const result = await validateApiKey("", {} as D1Database, env);
    expect("error" in result).toBe(true);
  });
});
