/**
 * routeRequest 对不存在模型的 fallback 行为测试
 *
 * 行为约定：没有任何平台支持请求的模型时（系统中不存在的模型），
 * routeRequest 直接返回 null，不再 fallback 到随机平台，
 * 由调用方（Pages/Worker 入口）响应 500 "此模型不存在"。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { routeRequest, forceRefreshRouterCache } from "../router";
import {
  recordFailure,
  checkAndUpdateCircuitBreakerState,
} from "../load-balancer";
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
  autoModelId: string | null = null,
  autoModelSelectedConfig: string | null = null
) {
  return {
    platforms: {
      findMany: async () => platforms,
      // 熔断状态机 recordFailure/recordSuccess 会写平台状态；桩为空操作即可，
      // 内存状态不受影响（halfOpenHeld 测试依赖）
      update: async () => ({}),
    },
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

// halfOpenHeld 测试使用 fake timers 推进熔断冷却期；用例中断时也要恢复真实
// 定时器，避免冻结的 Date.now() 污染后续用例（对未启用 fake 的用例是无操作）
afterEach(() => {
  vi.useRealTimers();
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

// ==================== halfOpenHeld 半开探测槽位归属标记（bug L5） ====================

/**
 * 行为约定：halfOpenHeld 仅在「平台经 selectPlatform 选中且选中时处于
 * half-open」时为 true（selectPlatform 内部执行了 halfOpenPending++）。
 * 消费方（proxy.ts / [[...v1]].ts）据此决定门禁拒绝时是否 releaseHalfOpenPending。
 */
describe("routeRequest halfOpenHeld 半开探测槽位归属标记", () => {
  /** 连续失败 5 次（DEFAULT_FAILURE_THRESHOLD）触发熔断 open，再推进冷却期转 half-open */
  async function tripToHalfOpen(platformId: string) {
    for (let i = 0; i < 5; i++) {
      await recordFailure(platformId, dummyDb);
    }
    expect(checkAndUpdateCircuitBreakerState(platformId)).toBe("open");
    // DEFAULT_COOLDOWN_MS = 60_000，推进超过冷却期后状态机转为 half-open
    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000);
    expect(checkAndUpdateCircuitBreakerState(platformId)).toBe("half-open");
  }

  it("经 selectPlatform 选中的 half-open 平台返回 halfOpenHeld=true", async () => {
    mockCreateDb.mockResolvedValue(
      makeFakePrisma(
        [makePlatform("p-half-lb", "HalfLB")],
        [{ platformId: "p-half-lb", modelId: "gpt-4o" }]
      ) as any
    );
    await forceRefreshRouterCache(dummyDb, env);

    await tripToHalfOpen("p-half-lb");

    // 负载均衡路径：selectPlatform 选中 half-open 平台并占用探测槽位
    const route = await routeRequest("gpt-4o", dummyDb, env);
    expect(route).not.toBeNull();
    expect(route!.platform.id).toBe("p-half-lb");
    expect(route!.halfOpenHeld).toBe(true);
  });

});
