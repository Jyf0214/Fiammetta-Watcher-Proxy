/**
 * model-fetcher.ts 模型自动发现测试
 *
 * 覆盖：
 * - fetchAllPlatformModels 主流程
 * - 拉取成功时替换模型列表（保留手动模型 enabled 状态）
 * - 拉取失败时保留旧数据
 * - 空模型列表不更新
 * - SSRF 不安全 URL 跳过
 * - isLockWaitTimeout 重试逻辑
 *
 * Mock @/lib/prisma、@/lib/detect-model-type、@/lib/admin-security、./platform-keys
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock detectModelType
vi.mock("@/lib/detect-model-type", () => ({
  detectModelType: vi.fn((_id: string) => "chat"),
}));

// Mock admin security
vi.mock("@/lib/admin-security", () => ({
  isSafeUrl: vi.fn(async () => ({ safe: true, reason: "" })),
}));

// Mock platform-keys
vi.mock("../platform-keys", () => ({
  parseApiKeys: vi.fn((raw: string) => {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map((k: any) => k.key).filter(Boolean) : [];
    } catch {
      return [];
    }
  }),
  parseApiKeyObjects: vi.fn(() => []),
  getNextKey: vi.fn((platform: { apiKeys: string[] }) => platform.apiKeys[0] ?? null),
}));

// Mock prisma — 注意：executeWithRetry 会调 prisma.$transaction，mock 必须包含
const mockFindMany = vi.fn();
const mockDeleteMany = vi.fn();
const mockCreateMany = vi.fn();
const mockGetDbKind = vi.fn();
const mockTransaction = vi.fn(async (fn: (tx: any) => Promise<any>) =>
  fn({
    platformModels: {
      findMany: mockFindMany,
      deleteMany: mockDeleteMany,
      createMany: mockCreateMany,
    },
  })
);
vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(async () => ({
    platforms: { findMany: mockFindMany },
    platformModels: {
      findMany: mockFindMany,
      deleteMany: mockDeleteMany,
      createMany: mockCreateMany,
    },
    $transaction: mockTransaction,
  })),
  getDbKind: vi.fn(async () => mockGetDbKind()),
}));

import { fetchAllPlatformModels } from "../model-fetcher";
import { isSafeUrl } from "@/lib/admin-security";

const mockDb = {} as D1Database;
const mockEnv = { DB_TYPE: "pg" } as any;

function makePlatform(overrides: Partial<{ id: string; name: string; baseUrl: string; apiKeys: string }> = {}): {
  id: string;
  name: string;
  baseUrl: string;
  apiKeys: string;
} {
  return {
    id: "p1",
    name: "TestPlatform",
    baseUrl: "https://api.openai.com/v1",
    apiKeys: JSON.stringify([{ name: "main", key: "sk-test-key" }]),
    ...overrides,
  };
}

function makeModelResponse(models: { id: string; owned_by?: string }[]) {
  return { data: models };
}

beforeEach(() => {
  vi.clearAllMocks();
  // 默认 SSRF 检查通过
  vi.mocked(isSafeUrl).mockResolvedValue({ safe: true, reason: "" });
  mockGetDbKind.mockResolvedValue("pg");
  // 默认 findMany 返回空（无已有模型）
  mockFindMany.mockResolvedValue([]);
  mockDeleteMany.mockResolvedValue({ count: 0 });
  mockCreateMany.mockResolvedValue({ count: 0 });
});

describe("fetchAllPlatformModels", () => {
  it("无启用平台时不执行任何操作", async () => {
    mockFindMany.mockResolvedValueOnce([]);

    await fetchAllPlatformModels(mockDb, mockEnv);

    // findMany 只被调用一次（查询平台），不会查 platformModels
    expect(mockFindMany).toHaveBeenCalledTimes(1);
  });

  it("拉取成功时替换模型列表", async () => {
    const platform = makePlatform();
    mockFindMany.mockResolvedValueOnce([platform]); // platforms.findMany
    // platformModels.findMany 返回空（无已有模型）
    mockFindMany.mockResolvedValueOnce([]);

    // mock fetch 返回模型列表
    const mockModels = [
      { id: "gpt-4o", owned_by: "openai" },
      { id: "gpt-4o-mini", owned_by: "openai" },
    ];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(makeModelResponse(mockModels)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await fetchAllPlatformModels(mockDb, mockEnv);

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.objectContaining({
        headers: { Authorization: "Bearer sk-test-key" },
        redirect: "manual",
      })
    );
    // 删除旧自动发现模型
    expect(mockDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { platformId: "p1", source: "auto" },
      })
    );
    // 插入新模型
    expect(mockCreateMany).toHaveBeenCalled();
    const createCall = mockCreateMany.mock.calls[0][0];
    expect(createCall.data).toHaveLength(2);
    expect(createCall.data[0].modelId).toBe("gpt-4o");
    expect(createCall.data[0].source).toBe("auto");
    expect(createCall.data[0].enabled).toBe(true);

    fetchSpy.mockRestore();
  });

  it("拉取失败时保留旧数据", async () => {
    const platform = makePlatform();
    mockFindMany.mockResolvedValueOnce([platform]);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Internal Server Error", { status: 500 })
    );

    await fetchAllPlatformModels(mockDb, mockEnv);

    // 不应删除或插入
    expect(mockDeleteMany).not.toHaveBeenCalled();
    expect(mockCreateMany).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it("上游返回空列表时保留旧数据", async () => {
    const platform = makePlatform();
    mockFindMany.mockResolvedValueOnce([platform]);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await fetchAllPlatformModels(mockDb, mockEnv);

    expect(mockDeleteMany).not.toHaveBeenCalled();
    expect(mockCreateMany).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it("SSRF 不安全 URL 跳过拉取", async () => {
    const platform = makePlatform({ baseUrl: "http://192.168.1.1/v1" });
    mockFindMany.mockResolvedValueOnce([platform]);

    vi.mocked(isSafeUrl).mockResolvedValueOnce({ safe: false, reason: "private IP" });

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await fetchAllPlatformModels(mockDb, mockEnv);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockDeleteMany).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it("已有模型保留 enabled 状态", async () => {
    const platform = makePlatform();
    mockFindMany.mockResolvedValueOnce([platform]); // platforms
    // 已有模型，其中 gpt-4o 被手动禁用
    mockFindMany.mockResolvedValueOnce([
      { modelId: "gpt-4o", enabled: false, source: "manual" },
    ]);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(makeModelResponse([
        { id: "gpt-4o", owned_by: "openai" },
        { id: "gpt-4o-mini", owned_by: "openai" },
      ])), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await fetchAllPlatformModels(mockDb, mockEnv);

    expect(mockCreateMany).toHaveBeenCalled();
    const createCall = mockCreateMany.mock.calls[0][0];
    // gpt-4o 保留 disabled 状态
    const gpt4o = createCall.data.find((m: any) => m.modelId === "gpt-4o");
    expect(gpt4o.enabled).toBe(false);
    // gpt-4o-mini 是新模型，默认启用
    const gpt4oMini = createCall.data.find((m: any) => m.modelId === "gpt-4o-mini");
    expect(gpt4oMini.enabled).toBe(true);

    fetchSpy.mockRestore();
  });

  it("fetch 网络错误时保留旧数据", async () => {
    const platform = makePlatform();
    mockFindMany.mockResolvedValueOnce([platform]);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("network error")
    );

    await fetchAllPlatformModels(mockDb, mockEnv);

    expect(mockDeleteMany).not.toHaveBeenCalled();
    expect(mockCreateMany).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it("无 API Key 时跳过", async () => {
    const platform = makePlatform({ apiKeys: JSON.stringify([]) });
    mockFindMany.mockResolvedValueOnce([platform]);

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await fetchAllPlatformModels(mockDb, mockEnv);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockDeleteMany).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it("分批插入（超过 100 个模型时多次 createMany）", async () => {
    const platform = makePlatform();
    mockFindMany.mockResolvedValueOnce([platform]);
    mockFindMany.mockResolvedValueOnce([]);

    // 生成 150 个模型
    const models = Array.from({ length: 150 }, (_, i) => ({
      id: `model-${i}`,
      owned_by: "test",
    }));

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(makeModelResponse(models)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await fetchAllPlatformModels(mockDb, mockEnv);

    // 应该分 2 批：0-99 和 100-149
    expect(mockCreateMany).toHaveBeenCalledTimes(2);
    expect(mockCreateMany.mock.calls[0][0].data).toHaveLength(100);
    expect(mockCreateMany.mock.calls[1][0].data).toHaveLength(50);

    fetchSpy.mockRestore();
  });
});
