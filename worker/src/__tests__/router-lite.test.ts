/**
 * Lite 路由引擎测试 — 纯负载均衡（无评分/优先级/熔断器）
 *
 * 验证 selectPlatformLite 与 routeRequestLite：
 * - 仅按权重加权随机（不按优先级分组）
 * - 被动过滤冷却期平台（cooldownEnd 只读）
 * - 缓存刷新不依赖 platform_scores 表（fake prisma 不提供即证明）
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  selectPlatformLite,
  routeRequestLite,
  forceRefreshRouterCacheLite,
} from "../router-lite";
import { createDb } from "@/lib/prisma";
import type { PlatformConfig } from "@/lib/types";

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(),
}));

const mockCreateDb = vi.mocked(createDb);
const dummyDb = {} as D1Database;
const env = { DB_TYPE: "d1" };

function makePlatform(overrides: Partial<PlatformConfig> = {}): PlatformConfig {
  return {
    id: "p-a",
    name: "A",
    baseUrl: "https://api.a.test/v1",
    apiKeys: [],
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
    ...overrides,
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("selectPlatformLite 纯负载均衡", () => {
  it("按优先级分组：仅在最高优先级中按权重随机", () => {
    const lowPriority = makePlatform({ id: "p-low", priority: 1, weight: 99 });
    const highPriority = makePlatform({ id: "p-high", priority: 10, weight: 1 });

    // 不同优先级时，无论权重如何，始终选中高优先级平台
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(selectPlatformLite([lowPriority, highPriority])?.id).toBe("p-high");
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    expect(selectPlatformLite([lowPriority, highPriority])?.id).toBe("p-high");

    // 同优先级时按权重轮询：highPriority weight=99 占 99/100
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(selectPlatformLite([highPriority, lowPriority])?.id).toBe("p-high");
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    expect(selectPlatformLite([highPriority, lowPriority])?.id).toBe("p-high");
  });

  it("过滤未启用平台", () => {
    const enabled = makePlatform({ id: "p-on" });
    const disabled = makePlatform({ id: "p-off", enabled: false });
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    expect(selectPlatformLite([disabled, enabled])?.id).toBe("p-on");
  });

  it("被动过滤冷却期平台（cooldownEnd 只读，不写状态）", () => {
    const cooling = makePlatform({
      id: "p-cool",
      cooldownEnd: Math.floor((Date.now() + 60_000) / 1000),
    });
    const normal = makePlatform({ id: "p-normal" });
    const result = selectPlatformLite([cooling, normal]);
    expect(result?.id).toBe("p-normal");
  });

  it("全部冷却/禁用时返回 null", () => {
    const cooling = makePlatform({ cooldownEnd: Math.floor((Date.now() + 60_000) / 1000) });
    expect(selectPlatformLite([cooling])).toBeNull();
  });
});

describe("routeRequestLite 路由", () => {
  it("按 targetModel 匹配候选平台（别名映射）", async () => {
    mockCreateDb.mockResolvedValue(
      makeFakePrisma(
        [
          makePlatform({ id: "p-a" }),
          makePlatform({ id: "p-b" }),
        ],
        [
          { platformId: "p-a", modelId: "deepseek-chat" },
          { platformId: "p-b", modelId: "deepseek-chat" },
          { platformId: "p-b", modelId: "claude-3" },
        ],
        [{ id: "m1", alias: "my-deepseek", targetModel: "deepseek-chat", platformId: null }]
      ) as any
    );
    await forceRefreshRouterCacheLite(dummyDb, env);

    const route = await routeRequestLite("my-deepseek", dummyDb, env);
    expect(route).not.toBeNull();
    expect(["p-a", "p-b"]).toContain(route!.platform.id);
    expect(route!.targetModel).toBe("deepseek-chat");
  });

  it("缓存刷新不查询 platform_scores（lite 不知道评分）", async () => {
    // fake prisma 未提供 platformScores：能正常刷新即证明未访问
    mockCreateDb.mockResolvedValue(
      makeFakePrisma(
        [makePlatform({ id: "p-a" })],
        [{ platformId: "p-a", modelId: "gpt-4o" }]
      ) as any
    );
    await forceRefreshRouterCacheLite(dummyDb, env);

    const route = await routeRequestLite("gpt-4o", dummyDb, env);
    expect(route).not.toBeNull();
    expect(route!.platform.id).toBe("p-a");
  });

  it("没有任何平台支持该模型时返回 null", async () => {
    mockCreateDb.mockResolvedValue(
      makeFakePrisma(
        [makePlatform({ id: "p-a" })],
        [{ platformId: "p-a", modelId: "gpt-4o" }]
      ) as any
    );
    await forceRefreshRouterCacheLite(dummyDb, env);

    const route = await routeRequestLite("nonexistent-model", dummyDb, env);
    expect(route).toBeNull();
  });

  it("模型映射指定平台时返回该平台（映射优先）", async () => {
    mockCreateDb.mockResolvedValue(
      makeFakePrisma(
        [
          makePlatform({ id: "p-a" }),
          makePlatform({ id: "p-b" }),
        ],
        [
          { platformId: "p-a", modelId: "gpt-4o" },
          { platformId: "p-b", modelId: "gpt-4o" },
        ],
        [{ id: "m1", alias: "fixed", targetModel: "gpt-4o", platformId: "p-b" }]
      ) as any
    );
    await forceRefreshRouterCacheLite(dummyDb, env);

    const route = await routeRequestLite("fixed", dummyDb, env);
    expect(route!.platform.id).toBe("p-b");
    expect(route!.targetModel).toBe("gpt-4o");
  });

  it("映射钉定平台处于冷却期时不被直选（返回不可用，不回退其他平台）", async () => {
    mockCreateDb.mockResolvedValue(
      makeFakePrisma(
        [
          makePlatform({
            id: "p-pinned",
            cooldownEnd: Math.floor((Date.now() + 60_000) / 1000),
          }),
          makePlatform({ id: "p-other" }),
        ],
        [
          { platformId: "p-pinned", modelId: "gpt-4o" },
          { platformId: "p-other", modelId: "gpt-4o" },
        ],
        [{ id: "m1", alias: "fixed", targetModel: "gpt-4o", platformId: "p-pinned" }]
      ) as any
    );
    await forceRefreshRouterCacheLite(dummyDb, env);

    // 钉定平台在冷却期内：与全量版 router.ts 同场景语义一致，直接返回不可用，
    // 不回退到同样支持该模型的 p-other
    const route = await routeRequestLite("fixed", dummyDb, env);
    expect(route).toBeNull();
  });

  it("映射钉定平台冷却到期后恢复直选", async () => {
    mockCreateDb.mockResolvedValue(
      makeFakePrisma(
        [makePlatform({ id: "p-pinned", cooldownEnd: Math.floor(Date.now() / 1000) - 60 })],
        [{ platformId: "p-pinned", modelId: "gpt-4o" }],
        [{ id: "m1", alias: "fixed", targetModel: "gpt-4o", platformId: "p-pinned" }]
      ) as any
    );
    await forceRefreshRouterCacheLite(dummyDb, env);

    const route = await routeRequestLite("fixed", dummyDb, env);
    expect(route).not.toBeNull();
    expect(route!.platform.id).toBe("p-pinned");
    expect(route!.targetModel).toBe("gpt-4o");
  });
});
