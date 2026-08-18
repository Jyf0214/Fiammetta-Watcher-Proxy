/**
 * platform-keys 单元测试
 *
 * 测试 Round-robin 密钥轮询逻辑
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAllKeys, getNextKey, getRandomKeyExcept, parseApiKeys, banKey, isKeyBanned, isKeyDeprioritized, loadWhitelist, recordKeyError, isKeyDisabled, loadKeyStatusFromKV, getKeyStatusesFromMemory, enableKey } from "../platform-keys";
import { keyStatusKey } from "@/lib/key-status";
import type { PlatformConfig } from "@/lib/types";

// recordKeyError 通过 update 持久化 apiKeys，这里用共享状态模拟"写入后可见"
const prismaState = vi.hoisted(() => ({
  apiKeysByPlatform: {} as Record<string, string>,
}));

// loadWhitelist / loadKeyStatusFromKV 内部通过 createDb 查库，这里替换为内存 mock
vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(async () => ({
    platforms: {
      findMany: async () => [
        { id: "platform-1", apiKeys: JSON.stringify([{ name: "w", key: "sk-whitelisted", whitelisted: true }, { name: "d", key: "sk-disabled", enabled: false }]), whitelisted: false },
        { id: "whitelisted-platform", apiKeys: JSON.stringify([{ name: "normal", key: "sk-normal" }]), whitelisted: true },
      ],
      findFirst: async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        apiKeys: prismaState.apiKeysByPlatform[where.id] ?? "",
      }),
      update: async ({ where, data }: { where: { id: string }; data: { apiKeys: string } }) => {
        prismaState.apiKeysByPlatform[where.id] = data.apiKeys;
      },
    },
  })),
}));

function makePlatform(overrides: Partial<PlatformConfig> = {}): PlatformConfig {
  return {
    id: "test-platform",
    name: "Test",
    baseUrl: "https://api.test.com/v1",
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

// ==================== getAllKeys ====================

describe("getAllKeys", () => {
  it("无密钥时返回空数组", () => {
    const keys = getAllKeys(makePlatform({ apiKeys: [] }));
    expect(keys).toEqual([]);
  });

  it("单密钥时返回单元素数组", () => {
    const keys = getAllKeys(makePlatform({ apiKeys: ["sk-main"] }));
    expect(keys).toEqual(["sk-main"]);
  });

  it("多密钥全部返回", () => {
    const keys = getAllKeys(makePlatform({
      apiKeys: ["sk-main", "sk-extra1", "sk-extra2"],
    }));
    expect(keys).toEqual(["sk-main", "sk-extra1", "sk-extra2"]);
  });

  it("跳过空字符串密钥", () => {
    const keys = getAllKeys(makePlatform({
      apiKeys: ["", "sk-extra", ""],
    }));
    expect(keys).toEqual(["sk-extra"]);
  });

  it("重复密钥去重（防止旧数据主密钥重复导致的失衡轮询）", () => {
    const keys = getAllKeys(makePlatform({
      apiKeys: ["sk-main", "sk-main", "sk-extra", "sk-extra"],
    }));
    expect(keys).toEqual(["sk-main", "sk-extra"]);
  });
});

// ==================== getNextKey ====================

describe("getNextKey", () => {
  beforeEach(() => {
    // 重置轮询计数器（通过获取所有平台的下一个 key 来"消耗"计数器）
    // 由于 counters 是模块级 Map，每个测试用独立 platform id
  });

  it("无密钥时返回 null", () => {
    const key = getNextKey(makePlatform({ id: "empty", apiKeys: [] }));
    expect(key).toBeNull();
  });

  it("单密钥时始终返回该密钥", () => {
    const platform = makePlatform({ id: "single", apiKeys: ["sk-only"] });
    expect(getNextKey(platform)).toBe("sk-only");
    expect(getNextKey(platform)).toBe("sk-only");
    expect(getNextKey(platform)).toBe("sk-only");
  });

  it("多密钥按 round-robin 轮询", () => {
    const platform = makePlatform({
      id: "round-robin",
      apiKeys: ["sk-a", "sk-b", "sk-c"],
    });
    // 轮询顺序：sk-a → sk-b → sk-c → sk-a → ...
    expect(getNextKey(platform)).toBe("sk-a");
    expect(getNextKey(platform)).toBe("sk-b");
    expect(getNextKey(platform)).toBe("sk-c");
    expect(getNextKey(platform)).toBe("sk-a");
    expect(getNextKey(platform)).toBe("sk-b");
  });

  it("不同平台独立轮询", () => {
    const p1 = makePlatform({ id: "p1", apiKeys: ["sk-1a", "sk-1b"] });
    const p2 = makePlatform({ id: "p2", apiKeys: ["sk-2a", "sk-2b"] });

    expect(getNextKey(p1)).toBe("sk-1a");
    expect(getNextKey(p2)).toBe("sk-2a");
    expect(getNextKey(p1)).toBe("sk-1b");
    expect(getNextKey(p2)).toBe("sk-2b");
    expect(getNextKey(p1)).toBe("sk-1a");
  });

  it("跳过 DB enabled=false 的密钥（进程重启后内存 disabledKeys 为空也不复活）", () => {
    const platform = makePlatform({
      id: "db-disabled",
      apiKeys: ["sk-bad", "sk-good"],
      apiKeyObjects: [
        { name: "bad", key: "sk-bad", whitelisted: false, enabled: false, errorCount: 5 },
        { name: "good", key: "sk-good", whitelisted: false, enabled: true, errorCount: 0 },
      ],
    });
    expect(getNextKey(platform)).toBe("sk-good");
    expect(getNextKey(platform)).toBe("sk-good");
  });

  it("全部密钥 DB 禁用时返回 null", () => {
    const platform = makePlatform({
      id: "all-db-disabled",
      apiKeys: ["sk-bad1", "sk-bad2"],
      apiKeyObjects: [
        { name: "bad1", key: "sk-bad1", whitelisted: false, enabled: false, errorCount: 5 },
        { name: "bad2", key: "sk-bad2", whitelisted: false, enabled: false, errorCount: 5 },
      ],
    });
    expect(getNextKey(platform)).toBeNull();
  });

  it("getRandomKeyExcept 跳过 DB enabled=false 的密钥（重试路径不复活禁用 Key）", () => {
    const platform = makePlatform({
      id: "random-db-disabled",
      apiKeys: ["sk-bad", "sk-good"],
      apiKeyObjects: [
        { name: "bad", key: "sk-bad", whitelisted: false, enabled: false, errorCount: 5 },
        { name: "good", key: "sk-good", whitelisted: false, enabled: true, errorCount: 0 },
      ],
    });
    const key = getRandomKeyExcept(platform, new Set());
    expect(key).toBe("sk-good");
  });
});

// ==================== parseApiKeys ====================

describe("parseApiKeys", () => {
  it("null/undefined 返回空数组", () => {
    expect(parseApiKeys(null)).toEqual([]);
    expect(parseApiKeys(undefined)).toEqual([]);
    expect(parseApiKeys("")).toEqual([]);
  });

  it("非 JSON 字符串返回空数组", () => {
    expect(parseApiKeys("not-json")).toEqual([]);
  });

  it("旧格式：字符串数组", () => {
    expect(parseApiKeys('["key1","key2"]')).toEqual(["key1", "key2"]);
  });

  it("新格式：对象数组 [{name, key}]", () => {
    const input = JSON.stringify([
      { name: "密钥1", key: "sk-aaa" },
      { name: "密钥2", key: "sk-bbb" },
    ]);
    expect(parseApiKeys(input)).toEqual(["sk-aaa", "sk-bbb"]);
  });

  it("跳过空 key 的对象", () => {
    const input = JSON.stringify([
      { name: "密钥1", key: "sk-ok" },
      { name: "密钥2", key: "" },
      { name: "密钥3", key: "  " },
    ]);
    expect(parseApiKeys(input)).toEqual(["sk-ok"]);
  });

  it("非数组 JSON 返回空数组", () => {
    expect(parseApiKeys('{"key":"value"}')).toEqual([]);
  });
});

// ==================== recordKeyError 白名单豁免 ====================

describe("recordKeyError 白名单豁免", () => {
  beforeEach(() => {
    // 重置持久化状态：platform-1 含白名单 Key w，whitelisted-platform 为白名单平台
    prismaState.apiKeysByPlatform = {
      "platform-1": JSON.stringify([
        { name: "normal", key: "sk-normal" },
        { name: "w", key: "sk-whitelisted", whitelisted: true },
      ]),
      "whitelisted-platform": JSON.stringify([{ name: "normal", key: "sk-normal" }]),
    };
  });

  it("白名单 Key 收到错误不累计计数、不被禁用，仅降级", async () => {
    await loadWhitelist({} as D1Database, { DB_TYPE: "d1" });

    for (let i = 0; i < 5; i++) {
      await recordKeyError("sk-whitelisted", 401, "platform-1", {} as D1Database);
    }

    expect(isKeyDisabled("sk-whitelisted", "platform-1")).toBe(false);
    expect(isKeyDeprioritized("sk-whitelisted", "platform-1")).toBe(true);
    // errorCount / enabled 未被持久化
    expect(prismaState.apiKeysByPlatform["platform-1"]).not.toContain('"errorCount"');
    expect(prismaState.apiKeysByPlatform["platform-1"]).not.toContain('"enabled":false');
  });

  it("非白名单 Key 达阈值仍自动禁用（回归）", async () => {
    await loadWhitelist({} as D1Database, { DB_TYPE: "d1" });

    // 401 每次 +2，3 次 = 6 >= 5
    for (let i = 0; i < 3; i++) {
      await recordKeyError("sk-normal", 401, "platform-1", {} as D1Database);
    }

    expect(isKeyDisabled("sk-normal", "platform-1")).toBe(true);
    expect(prismaState.apiKeysByPlatform["platform-1"]).toContain('"enabled":false');
    expect(prismaState.apiKeysByPlatform["platform-1"]).toContain('"errorCount":6');
  });

  it("402 一次即达阈值，白名单 Key 同样豁免", async () => {
    await loadWhitelist({} as D1Database, { DB_TYPE: "d1" });

    await recordKeyError("sk-whitelisted", 402, "platform-1", {} as D1Database);

    expect(isKeyDisabled("sk-whitelisted", "platform-1")).toBe(false);
    expect(isKeyDeprioritized("sk-whitelisted", "platform-1")).toBe(true);
    expect(prismaState.apiKeysByPlatform["platform-1"]).not.toContain('"enabled":false');
  });

  it("白名单平台的普通 Key 同样豁免", async () => {
    await loadWhitelist({} as D1Database, { DB_TYPE: "d1" });

    for (let i = 0; i < 5; i++) {
      await recordKeyError("sk-normal", 401, "whitelisted-platform", {} as D1Database);
    }

    expect(isKeyDisabled("sk-normal", "whitelisted-platform")).toBe(false);
    expect(isKeyDeprioritized("sk-normal", "whitelisted-platform")).toBe(true);
  });
});

// ==================== banKey KV 持久化 ====================

/** 内存版 KV mock（仅实现 get/put） */
function makeMockKv(): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
  } as unknown as KVNamespace & { store: Map<string, string> };
}

describe("banKey KV 持久化", () => {
  it("普通 Key 封禁后写入 KV（指纹维度）", async () => {
    const kv = makeMockKv();
    await banKey("sk-banned", undefined, "platform-1", kv);

    expect(isKeyBanned("sk-banned", "platform-1")).toBe(true);

    const raw = kv.store.get(keyStatusKey("platform-1"));
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    const entries = Object.entries(parsed);
    expect(entries.length).toBe(1);
    const [fp, value] = entries[0];
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
    expect((value as any).status).toBe("banned");
    expect((value as any).expireAt).toBeGreaterThan(Date.now());
  });

  it("白名单 Key 收到 429 后写入降级状态而非封禁", async () => {
    const kv = makeMockKv();
    await loadWhitelist({} as D1Database, { DB_TYPE: "d1" });

    await banKey("sk-whitelisted", undefined, "platform-1", kv);

    expect(isKeyBanned("sk-whitelisted", "platform-1")).toBe(false);
    expect(isKeyDeprioritized("sk-whitelisted", "platform-1")).toBe(true);

    const raw = kv.store.get(keyStatusKey("platform-1"));
    const parsed = JSON.parse(raw!);
    const value = Object.values(parsed)[0] as any;
    expect(value.status).toBe("deprioritized");
  });

  it("白名单平台的 Key 收到 429 后写入降级状态而非封禁", async () => {
    const kv = makeMockKv();
    // 单次覆盖 createDb：本次调用只返回白名单平台（mockResolvedValueOnce
    // 消费后自动恢复顶部 vi.mock 的默认实现，不影响后续测试）
    const { createDb } = await import("@/lib/prisma");
    vi.mocked(createDb).mockResolvedValueOnce({
      platforms: {
        findMany: async () => [
          { id: "whitelisted-platform", apiKeys: JSON.stringify([{ name: "normal", key: "sk-normal" }]), whitelisted: true },
        ],
      },
    } as never);
    await loadWhitelist({} as D1Database, { DB_TYPE: "d1" });

    await banKey("sk-normal", undefined, "whitelisted-platform", kv);

    expect(isKeyBanned("sk-normal", "whitelisted-platform")).toBe(false);
    expect(isKeyDeprioritized("sk-normal", "whitelisted-platform")).toBe(true);

    const raw = kv.store.get(keyStatusKey("whitelisted-platform"));
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    const value = Object.values(parsed)[0] as any;
    expect(value.status).toBe("deprioritized");
  });

  it("不传 KV 时仅更新内存态（兼容旧调用）", async () => {
    await banKey("sk-memory-only");
    expect(isKeyBanned("sk-memory-only")).toBe(true);
  });

  it("同值密钥在不同平台隔离封禁（一个平台 429 不连坐其它平台）", async () => {
    await banKey("sk-shared", undefined, "platform-a");
    expect(isKeyBanned("sk-shared", "platform-a")).toBe(true);
    expect(isKeyBanned("sk-shared", "platform-b")).toBe(false);

    // platform-a 所有密钥被封禁 → 无可用 Key（原始 500 场景）
    expect(getNextKey(makePlatform({ id: "platform-a", apiKeys: ["sk-shared"] }))).toBeNull();
    // platform-b 同值密钥不受影响，仍可轮询
    const key = getNextKey(makePlatform({ id: "platform-b", apiKeys: ["sk-shared"] }));
    expect(key).toBe("sk-shared");
  });
});

// ==================== loadKeyStatusFromKV ====================

describe("loadKeyStatusFromKV", () => {
  it("无 KV 时从 DB 恢复持久化禁用密钥（非 Cloudflare 部署重启后禁用不复活）", async () => {
    // 先确保内存态干净：启用状态下断言
    expect(isKeyDisabled("sk-disabled", "platform-1")).toBe(false);

    // 无 KV（undefined）：退化为仅从 DB 恢复 enabled=false 的密钥
    await loadKeyStatusFromKV({} as D1Database, undefined, { DB_TYPE: "d1" });

    expect(isKeyDisabled("sk-disabled", "platform-1")).toBe(true);
    // 正常密钥不受影响
    expect(isKeyDisabled("sk-whitelisted", "platform-1")).toBe(false);
    // 白名单密钥不会进入禁用集合
    expect(isKeyDisabled("sk-normal", "whitelisted-platform")).toBe(false);
  });
});

// ==================== getKeyStatusesFromMemory（管理后台同进程读取） ====================

describe("getKeyStatusesFromMemory", () => {
  it("普通 Key 封禁后按指纹返回 banned 状态与到期时间", async () => {
    await banKey("sk-banned", undefined, "platform-1");

    const statuses = getKeyStatusesFromMemory("platform-1", ["sk-banned", "sk-normal"]);
    const fp = Object.keys(statuses);
    expect(fp.length).toBe(1);
    expect(statuses[fp[0]].status).toBe("banned");
    expect(statuses[fp[0]].expireAt).toBeGreaterThan(Date.now());
  });

  it("白名单 Key 降级后返回 deprioritized 状态", async () => {
    await loadWhitelist({} as D1Database, { DB_TYPE: "d1" });
    await banKey("sk-whitelisted", undefined, "platform-1");

    const statuses = getKeyStatusesFromMemory("platform-1", ["sk-whitelisted"]);
    const entries = Object.values(statuses);
    expect(entries.length).toBe(1);
    expect(entries[0].status).toBe("deprioritized");
  });

  it("无任何状态时返回空对象", () => {
    const statuses = getKeyStatusesFromMemory("platform-1", ["sk-clean"]);
    expect(statuses).toEqual({});
  });

  it("已到期冷却不计入（过期自动清理语义）", async () => {
    // 负时长构造已过期冷却
    await banKey("sk-expired", -1000, "platform-1");
    expect(isKeyBanned("sk-expired", "platform-1")).toBe(false);

    const statuses = getKeyStatusesFromMemory("platform-1", ["sk-expired"]);
    expect(statuses).toEqual({});
  });

  it("平台维度隔离：platform-a 封禁不影响 platform-b 的状态读取", async () => {
    await banKey("sk-shared", undefined, "platform-a");

    const a = getKeyStatusesFromMemory("platform-a", ["sk-shared"]);
    expect(Object.keys(a).length).toBe(1);
    const b = getKeyStatusesFromMemory("platform-b", ["sk-shared"]);
    expect(b).toEqual({});
  });
});

// ==================== enableKey 统一清理（#8：手动启用 = DB 清零 + 内存冷却清理 + KV 残留删除） ====================

describe("enableKey 统一清理", () => {
  beforeEach(() => {
    // 重置持久化状态：platform-1 含白名单 Key w，whitelisted-platform 为白名单平台
    prismaState.apiKeysByPlatform = {
      "platform-1": JSON.stringify([
        { name: "normal", key: "sk-normal" },
        { name: "w", key: "sk-whitelisted", whitelisted: true },
      ]),
      "whitelisted-platform": JSON.stringify([{ name: "normal", key: "sk-normal" }]),
    };
  });

  it("清除持久化禁用标记并清零 DB 错误计数", async () => {
    await loadWhitelist({} as D1Database, { DB_TYPE: "d1" });
    // 3 次 401（每次 +2）= 6 达阈值自动禁用
    for (let i = 0; i < 3; i++) {
      await recordKeyError("sk-normal", 401, "platform-1", {} as D1Database);
    }
    expect(isKeyDisabled("sk-normal", "platform-1")).toBe(true);

    const { createDb } = await import("@/lib/prisma");
    const db = await createDb({});
    await enableKey("sk-normal", "platform-1", db as never);

    expect(isKeyDisabled("sk-normal", "platform-1")).toBe(false);
    expect(prismaState.apiKeysByPlatform["platform-1"]).not.toContain('"enabled":false');
    expect(prismaState.apiKeysByPlatform["platform-1"]).not.toContain('"errorCount"');
  });

  it("清除 429 封禁冷却并删除 KV banned 残留", async () => {
    const kv = makeMockKv();
    await banKey("sk-normal", undefined, "platform-1", kv);
    expect(isKeyBanned("sk-normal", "platform-1")).toBe(true);
    expect(kv.store.size).toBe(1);

    const { createDb } = await import("@/lib/prisma");
    const db = await createDb({});
    await enableKey("sk-normal", "platform-1", db as never, kv);

    expect(isKeyBanned("sk-normal", "platform-1")).toBe(false);
    // KV 残留一并删除，冷启动 loadKeyStatusFromKV 不会恢复封禁
    const raw = kv.store.get(keyStatusKey("platform-1"));
    expect(raw).toBeTruthy();
    expect(Object.keys(JSON.parse(raw!)).length).toBe(0);
  });

  it("清除白名单 Key 的降级冷却", async () => {
    await loadWhitelist({} as D1Database, { DB_TYPE: "d1" });
    await banKey("sk-whitelisted", undefined, "platform-1");
    expect(isKeyDeprioritized("sk-whitelisted", "platform-1")).toBe(true);

    const { createDb } = await import("@/lib/prisma");
    const db = await createDb({});
    await enableKey("sk-whitelisted", "platform-1", db as never);

    expect(isKeyDeprioritized("sk-whitelisted", "platform-1")).toBe(false);
  });

  it("启用后可立即被 getNextKey 选中（封禁立即解除）", async () => {
    await loadWhitelist({} as D1Database, { DB_TYPE: "d1" });
    // 3 次 401 达阈值自动禁用
    for (let i = 0; i < 3; i++) {
      await recordKeyError("sk-normal", 401, "platform-1", {} as D1Database);
    }
    expect(getNextKey(makePlatform({ id: "platform-1", apiKeys: ["sk-normal"] }))).toBeNull();

    const { createDb } = await import("@/lib/prisma");
    const db = await createDb({});
    await enableKey("sk-normal", "platform-1", db as never);

    expect(getNextKey(makePlatform({ id: "platform-1", apiKeys: ["sk-normal"] }))).toBe("sk-normal");
  });
});

// ==================== 白名单平台 Key 降级路径（#11：tier2/3 门槛放开） ====================

describe("白名单平台 Key 降级路径", () => {
  it("白名单平台的普通 Key 429 降级后仍可被 getNextKey 选中（最后手段）", async () => {
    await loadWhitelist({} as D1Database, { DB_TYPE: "d1" });
    await banKey("sk-normal", undefined, "whitelisted-platform");
    expect(isKeyDeprioritized("sk-normal", "whitelisted-platform")).toBe(true);

    const key = getNextKey(makePlatform({ id: "whitelisted-platform", apiKeys: ["sk-normal"] }));
    expect(key).toBe("sk-normal");
  });

  it("白名单平台的普通 Key 429 降级后仍可被 getRandomKeyExcept 选中（重试路径）", async () => {
    await loadWhitelist({} as D1Database, { DB_TYPE: "d1" });
    await banKey("sk-normal", undefined, "whitelisted-platform");

    const key = getRandomKeyExcept(
      makePlatform({ id: "whitelisted-platform", apiKeys: ["sk-normal"] }),
      new Set()
    );
    expect(key).toBe("sk-normal");
  });

  it("非白名单平台的普通 Key 封禁后仍被移除（5 分钟封禁语义不变）", async () => {
    await loadWhitelist({} as D1Database, { DB_TYPE: "d1" });
    await banKey("sk-normal", undefined, "platform-1");
    expect(isKeyBanned("sk-normal", "platform-1")).toBe(true);

    expect(getNextKey(makePlatform({ id: "platform-1", apiKeys: ["sk-normal"] }))).toBeNull();
    expect(getRandomKeyExcept(makePlatform({ id: "platform-1", apiKeys: ["sk-normal"] }), new Set())).toBeNull();
  });
});
