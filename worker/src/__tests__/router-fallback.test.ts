/**
 * routeRequest 对不存在模型的 fallback 行为测试
 *
 * 行为约定：没有任何平台支持请求的模型时（系统中不存在的模型），
 * routeRequest 直接返回 null，不再 fallback 到随机平台，
 * 由调用方（Pages/Worker 入口）响应 500 "此模型不存在"。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { routeRequest, forceRefreshRouterCache } from "../router";
import { createDb } from "@/lib/prisma";

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(),
}));

const mockCreateDb = vi.mocked(createDb);
const dummyDb = {} as D1Database;
const env = { DB_TYPE: "d1" };

function makePlatform(id: string, name: string) {
  return {
    id,
    name,
    baseUrl: `https://api.${id}.test/v1`,
    apiKey: `sk-${id}`,
    apiKeys: null,
    type: "openai",
    enabled: true,
    priority: 0,
    weight: 1,
    rpmLimit: null,
    tpmLimit: null,
    forwardHeaders: "",
    status: "healthy",
    failCount: 0,
    lastFailAt: null,
    cooldownEnd: null,
  };
}

function makeFakePrisma(
  platforms: any[],
  platformModels: { platformId: string; modelId: string }[],
  mappings: any[] = [],
  autoModelId: string | null = null
) {
  return {
    platforms: { findMany: async () => platforms },
    modelMappings: { findMany: async () => mappings },
    platformModels: { findMany: async () => platformModels },
    configs: {
      findFirst: async () => (autoModelId ? { value: autoModelId } : null),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("routeRequest 对不存在模型的 fallback 行为", () => {
  it("没有任何平台支持该模型时返回 null", async () => {
    mockCreateDb.mockResolvedValue(
      makeFakePrisma(
        [makePlatform("p-a", "A")],
        [{ platformId: "p-a", modelId: "gpt-4o" }]
      ) as any
    );
    await forceRefreshRouterCache(dummyDb, env);

    const route = await routeRequest("nonexistent-model", dummyDb, env);
    expect(route).toBeNull();
  });

  it("多个平台且都不支持该模型时返回 null（不随机选中任一平台）", async () => {
    mockCreateDb.mockResolvedValue(
      makeFakePrisma(
        [makePlatform("p-a", "A"), makePlatform("p-b", "B")],
        [
          { platformId: "p-a", modelId: "gpt-4o" },
          { platformId: "p-b", modelId: "claude-3" },
        ]
      ) as any
    );
    await forceRefreshRouterCache(dummyDb, env);

    const route = await routeRequest("deepseek-v4-flash", dummyDb, env);
    expect(route).toBeNull();
  });

  it("平台支持该模型时正常返回路由（不破坏正常路径）", async () => {
    mockCreateDb.mockResolvedValue(
      makeFakePrisma(
        [makePlatform("p-a", "A")],
        [{ platformId: "p-a", modelId: "gpt-4o" }]
      ) as any
    );
    await forceRefreshRouterCache(dummyDb, env);

    const route = await routeRequest("gpt-4o", dummyDb, env);
    expect(route).not.toBeNull();
    expect(route!.platform.id).toBe("p-a");
    expect(route!.targetModel).toBe("gpt-4o");
  });

  it("多个平台时选择支持该模型的平台（负载均衡候选集不受影响）", async () => {
    mockCreateDb.mockResolvedValue(
      makeFakePrisma(
        [makePlatform("p-a", "A"), makePlatform("p-b", "B")],
        [
          { platformId: "p-a", modelId: "gpt-4o" },
          { platformId: "p-b", modelId: "gpt-4o" },
          { platformId: "p-b", modelId: "claude-3" },
        ]
      ) as any
    );
    await forceRefreshRouterCache(dummyDb, env);

    const route = await routeRequest("gpt-4o", dummyDb, env);
    expect(route).not.toBeNull();
    expect(["p-a", "p-b"]).toContain(route!.platform.id);
  });

  it("模型映射指定平台时返回该平台（映射优先于平台模型缓存）", async () => {
    mockCreateDb.mockResolvedValue(
      makeFakePrisma(
        [makePlatform("p-a", "A")],
        [{ platformId: "p-a", modelId: "gpt-4o" }],
        [
          {
            id: "m1",
            alias: "my-deepseek",
            targetModel: "deepseek-chat",
            platformId: "p-a",
          },
        ]
      ) as any
    );
    await forceRefreshRouterCache(dummyDb, env);

    const route = await routeRequest("my-deepseek", dummyDb, env);
    expect(route).not.toBeNull();
    expect(route!.platform.id).toBe("p-a");
    expect(route!.targetModel).toBe("deepseek-chat");
  });

  it("无平台 ID 的模型映射按 targetModel 路由（别名不在平台模型缓存中）", async () => {
    mockCreateDb.mockResolvedValue(
      makeFakePrisma(
        [makePlatform("p-a", "A"), makePlatform("p-b", "B")],
        [
          { platformId: "p-a", modelId: "deepseek-chat" },
          { platformId: "p-b", modelId: "claude-3" },
        ],
        [
          {
            id: "m1",
            alias: "my-deepseek",
            targetModel: "deepseek-chat",
            platformId: null,
          },
        ]
      ) as any
    );
    await forceRefreshRouterCache(dummyDb, env);

    // 必须命中支持 targetModel 的 p-a；旧 fallback 会随机选中 p-a/p-b 导致不稳定
    const route = await routeRequest("my-deepseek", dummyDb, env);
    expect(route).not.toBeNull();
    expect(route!.platform.id).toBe("p-a");
    expect(route!.targetModel).toBe("deepseek-chat");
  });

  it("无平台 ID 的通配符映射按拼接后的 targetModel 路由", async () => {
    mockCreateDb.mockResolvedValue(
      makeFakePrisma(
        [makePlatform("p-a", "A"), makePlatform("p-b", "B")],
        [
          { platformId: "p-a", modelId: "gpt-4o" },
          { platformId: "p-b", modelId: "claude-3" },
        ],
        [
          {
            id: "m1",
            alias: "oai-*",
            targetModel: "gpt-",
            platformId: null,
          },
        ]
      ) as any
    );
    await forceRefreshRouterCache(dummyDb, env);

    // 请求名 "oai-4o" 不在任何平台缓存中，但拼接后的 targetModel "gpt-4o" 在 p-a：
    // 必须按 targetModel 路由到 p-a；旧 fallback 会随机选中 p-a/p-b 导致不稳定
    const route = await routeRequest("oai-4o", dummyDb, env);
    expect(route).not.toBeNull();
    expect(route!.platform.id).toBe("p-a");
    expect(route!.targetModel).toBe("gpt-4o");
  });

  it("映射的目标模型无平台支持时返回 null", async () => {
    mockCreateDb.mockResolvedValue(
      makeFakePrisma(
        [makePlatform("p-a", "A")],
        [{ platformId: "p-a", modelId: "gpt-4o" }],
        [
          {
            id: "m1",
            alias: "my-deepseek",
            targetModel: "deepseek-chat",
            platformId: null,
          },
        ]
      ) as any
    );
    await forceRefreshRouterCache(dummyDb, env);

    const route = await routeRequest("my-deepseek", dummyDb, env);
    expect(route).toBeNull();
  });
});
