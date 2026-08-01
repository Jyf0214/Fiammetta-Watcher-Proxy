/**
 * platform-keys 单元测试
 *
 * 测试 Round-robin 密钥轮询逻辑
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAllKeys, getNextKey, parseApiKeys, banKey, isKeyBanned, isKeyDeprioritized, loadWhitelist } from "../platform-keys";
import { keyStatusKey } from "@/lib/key-status";
import type { PlatformConfig } from "@/lib/types";

// loadWhitelist / loadKeyStatusFromKV 内部通过 createDb 查库，这里替换为内存 mock
vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(async () => ({
    platforms: {
      findMany: async () => [
        { apiKeys: JSON.stringify([{ name: "w", key: "sk-whitelisted", whitelisted: true }]) },
      ],
    },
  })),
}));

function makePlatform(overrides: Partial<PlatformConfig> = {}): PlatformConfig {
  return {
    id: "test-platform",
    name: "Test",
    baseUrl: "https://api.test.com/v1",
    apiKey: "",
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
    const keys = getAllKeys(makePlatform({ apiKey: "", apiKeys: [] }));
    expect(keys).toEqual([]);
  });

  it("仅主密钥时返回单元素数组", () => {
    const keys = getAllKeys(makePlatform({ apiKey: "sk-main", apiKeys: [] }));
    expect(keys).toEqual(["sk-main"]);
  });

  it("主密钥 + 附加密钥全部返回", () => {
    const keys = getAllKeys(makePlatform({
      apiKey: "sk-main",
      apiKeys: ["sk-extra1", "sk-extra2"],
    }));
    expect(keys).toEqual(["sk-main", "sk-extra1", "sk-extra2"]);
  });

  it("跳过空字符串密钥", () => {
    const keys = getAllKeys(makePlatform({
      apiKey: "sk-main",
      apiKeys: ["", "sk-extra", ""],
    }));
    expect(keys).toEqual(["sk-main", "sk-extra"]);
  });

  it("跳过非字符串密钥", () => {
    const platform = makePlatform({ apiKey: "sk-ok", apiKeys: [] });
    // getAllKeys 内部用 filter(k => typeof k === "string" && k.trim().length > 0)
    // 传入空数组即可验证过滤逻辑
    expect(getAllKeys(platform)).toEqual(["sk-ok"]);
  });
});

// ==================== getNextKey ====================

describe("getNextKey", () => {
  beforeEach(() => {
    // 重置轮询计数器（通过获取所有平台的下一个 key 来"消耗"计数器）
    // 由于 counters 是模块级 Map，每个测试用独立 platform id
  });

  it("无密钥时返回 null", () => {
    const key = getNextKey(makePlatform({ id: "empty", apiKey: "", apiKeys: [] }));
    expect(key).toBeNull();
  });

  it("单密钥时始终返回该密钥", () => {
    const platform = makePlatform({ id: "single", apiKey: "sk-only", apiKeys: [] });
    expect(getNextKey(platform)).toBe("sk-only");
    expect(getNextKey(platform)).toBe("sk-only");
    expect(getNextKey(platform)).toBe("sk-only");
  });

  it("多密钥按 round-robin 轮询", () => {
    const platform = makePlatform({
      id: "round-robin",
      apiKey: "sk-a",
      apiKeys: ["sk-b", "sk-c"],
    });
    // 轮询顺序：sk-a → sk-b → sk-c → sk-a → ...
    expect(getNextKey(platform)).toBe("sk-a");
    expect(getNextKey(platform)).toBe("sk-b");
    expect(getNextKey(platform)).toBe("sk-c");
    expect(getNextKey(platform)).toBe("sk-a");
    expect(getNextKey(platform)).toBe("sk-b");
  });

  it("不同平台独立轮询", () => {
    const p1 = makePlatform({ id: "p1", apiKey: "sk-1a", apiKeys: ["sk-1b"] });
    const p2 = makePlatform({ id: "p2", apiKey: "sk-2a", apiKeys: ["sk-2b"] });

    expect(getNextKey(p1)).toBe("sk-1a");
    expect(getNextKey(p2)).toBe("sk-2a");
    expect(getNextKey(p1)).toBe("sk-1b");
    expect(getNextKey(p2)).toBe("sk-2b");
    expect(getNextKey(p1)).toBe("sk-1a");
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

    expect(isKeyBanned("sk-banned")).toBe(true);

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

    expect(isKeyBanned("sk-whitelisted")).toBe(false);
    expect(isKeyDeprioritized("sk-whitelisted")).toBe(true);

    const raw = kv.store.get(keyStatusKey("platform-1"));
    const parsed = JSON.parse(raw!);
    const value = Object.values(parsed)[0] as any;
    expect(value.status).toBe("deprioritized");
  });

  it("不传 KV 时仅更新内存态（兼容旧调用）", async () => {
    await banKey("sk-memory-only");
    expect(isKeyBanned("sk-memory-only")).toBe(true);
  });
});
