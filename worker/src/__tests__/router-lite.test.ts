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
  it("仅按权重随机：不按优先级分组（低优先级高权重仍会被选中）", () => {
    const lowPriority = makePlatform({ id: "p-low", priority: 1, weight: 1 });
    const highPriority = makePlatform({ id: "p-high", priority: 10, weight: 99 });

    // random 接近 0 → 命中权重顺序中的第一个候选（lowPriority 在前，weight 1）
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(selectPlatformLite([lowPriority, highPriority])?.id).toBe("p-low");
    // random 接近 1 → 落到权重区间的末端（highPriority 占 99/100，必被命中）
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    expect(selectPlatformLite([lowPriority, highPriority])?.id).toBe("p-high");
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
      cooldownEnd: Date.now() + 60_000,
    });
    const normal = makePlatform({ id: "p-normal" });
    const result = selectPlatformLite([cooling, normal]);
    expect(result?.id).toBe("p-normal");
  });

  it("全部冷却/禁用时返回 null", () => {
    const cooling = makePlatform({ cooldownEnd: Date.now() + 60_000 });
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
});
