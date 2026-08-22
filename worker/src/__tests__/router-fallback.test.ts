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
  autoModelId: string | null = null,
  autoModelSelectedConfig: string | null = null
) {
  return {
    platforms: { findMany: async () => platforms },
    modelMappings: { findMany: async () => mappings },
    platformModels: { findMany: async () => platformModels },
    configs: {
      findFirst: async ({ where }: { where: { key: string } }) => {
        if (where.key === "system:auto_model_selected") {
          return autoModelSelectedConfig ? { value: autoModelSelectedConfig } : null;
        }
        return autoModelId ? { value: autoModelId } : null;
      },
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

// ==================== 自动模型分流白名单（system:auto_model_selected） ====================

describe("routeRequest 自动模型分流白名单", () => {
  const AUTO = "fwp-auto-model";

  it("未配置白名单时全部模型参与分流（向后兼容）", async () => {
    mockCreateDb.mockResolvedValue(
      makeFakePrisma(
        [makePlatform("p-a", "A"), makePlatform("p-b", "B")],
        [
          { platformId: "p-a", modelId: "gpt-4o" },
          { platformId: "p-b", modelId: "claude-3" },
        ],
        [],
        AUTO
      ) as any
    );
    await forceRefreshRouterCache(dummyDb, env);

    const route = await routeRequest(AUTO, dummyDb, env);
    expect(route).not.toBeNull();
    expect(["p-a", "p-b"]).toContain(route!.platform.id);
    expect(["gpt-4o", "claude-3"]).toContain(route!.targetModel);
  });

  it("白名单只含部分模型时仅路由到入选模型", async () => {
    mockCreateDb.mockResolvedValue(
      makeFakePrisma(
        [makePlatform("p-a", "A"), makePlatform("p-b", "B")],
        [
          { platformId: "p-a", modelId: "gpt-4o" },
          { platformId: "p-b", modelId: "claude-3" },
        ],
        [],
        AUTO,
        JSON.stringify(["gpt-4o"])
      ) as any
    );
    await forceRefreshRouterCache(dummyDb, env);

    const route = await routeRequest(AUTO, dummyDb, env);
    expect(route).not.toBeNull();
    expect(route!.platform.id).toBe("p-a");
    expect(route!.targetModel).toBe("gpt-4o");
  });

  it("白名单为空数组（UI 全部关闭）时无模型参与，返回 null", async () => {
    mockCreateDb.mockResolvedValue(
      makeFakePrisma(
        [makePlatform("p-a", "A")],
        [{ platformId: "p-a", modelId: "gpt-4o" }],
        [],
        AUTO,
        JSON.stringify([])
      ) as any
    );
    await forceRefreshRouterCache(dummyDb, env);

    const route = await routeRequest(AUTO, dummyDb, env);
    expect(route).toBeNull();
  });

  it("白名单数组元素全非法时 fail-closed（空集合，无模型参与）", async () => {
    mockCreateDb.mockResolvedValue(
      makeFakePrisma(
        [makePlatform("p-a", "A")],
        [{ platformId: "p-a", modelId: "gpt-4o" }],
        [],
        AUTO,
        JSON.stringify([1, 2])
      ) as any
    );
    await forceRefreshRouterCache(dummyDb, env);

    // 全非法元素 → 空集合（fail-closed），无模型参与，路由返回 null
    const route = await routeRequest(AUTO, dummyDb, env);
    expect(route).toBeNull();
  });

  it("高优先级平台无入选模型时路由到有入选模型的平台（不 500）", async () => {
    // p-a 优先级更高但入选模型只有 p-b 的 claude-3：
    // 旧实现先 selectPlatform 选中 p-a 再查模型落空返回 null，即使 p-b 有可用模型
    mockCreateDb.mockResolvedValue(
      makeFakePrisma(
        [
          { ...makePlatform("p-a", "A"), priority: 10 },
          makePlatform("p-b", "B"),
        ],
        [
          { platformId: "p-a", modelId: "gpt-4o" },
          { platformId: "p-b", modelId: "claude-3" },
        ],
        [],
        AUTO,
        JSON.stringify(["claude-3"])
      ) as any
    );
    await forceRefreshRouterCache(dummyDb, env);

    const route = await routeRequest(AUTO, dummyDb, env);
    expect(route).not.toBeNull();
    expect(route!.platform.id).toBe("p-b");
    expect(route!.targetModel).toBe("claude-3");
  });
});
