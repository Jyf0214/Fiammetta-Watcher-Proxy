/**
 * rate-limiter.ts KV 速率限制测试
 *
 * 覆盖：
 * - checkPlatformRpm / checkPlatformTpm
 * - checkApiKeyRpm / checkApiKeyTpm
 * - null 限制不拦截
 * - TOCTOU 缓冲（count >= limit - 1 时拒绝）
 * - KV 读写与 TTL
 *
 * 使用内存 Map 模拟 KVNamespace
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  checkPlatformRpm,
  checkPlatformTpm,
  checkApiKeyRpm,
  checkApiKeyTpm,
} from "../rate-limiter";

/** 内存 KV mock */
function makeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string, _opts?: { type?: "text" }) => {
      return store.get(key) ?? null;
    },
    put: async (key: string, value: string, _opts?: { expirationTtl?: number }) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({ keys: [], list_complete: true }),
  } as unknown as KVNamespace;
}

// ==================== checkPlatformRpm ====================

describe("checkPlatformRpm", () => {
  let kv: KVNamespace;
  beforeEach(() => {
    kv = makeKv();
  });

  it("rpmLimit=null 时不限制", async () => {
    const result = await checkPlatformRpm("p1", null, kv);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(Infinity);
  });

  it("首次请求允许且递增计数", async () => {
    const result = await checkPlatformRpm("p1", 10, kv);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(8); // limit - count - 2 = 10 - 0 - 2 = 8
  });

  it("达到 limit-1 时拒绝（TOCTOU 缓冲）", async () => {
    // rpmLimit=3，缓冲后 count >= 2 时拒绝
    await checkPlatformRpm("p1", 3, kv); // count 0→1, remaining=1
    await checkPlatformRpm("p1", 3, kv); // count 1→2, remaining=0
    const result = await checkPlatformRpm("p1", 3, kv); // count=2 >= 3-1=2 → 拒绝
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("resetAt 为窗口起始 + WINDOW_MS", async () => {
    const result = await checkPlatformRpm("p1", 100, kv);
    const now = Date.now();
    const windowStart = Math.floor(now / 60000) * 60000;
    expect(result.resetAt).toBe(windowStart + 60000);
  });
});

// ==================== checkPlatformTpm ====================

describe("checkPlatformTpm", () => {
  let kv: KVNamespace;
  beforeEach(() => {
    kv = makeKv();
  });

  it("tpmLimit=null 时不限制", async () => {
    const result = await checkPlatformTpm("p1", null, 100, kv);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(Infinity);
  });

  it("tokenCount<=0 时不限制", async () => {
    const result = await checkPlatformTpm("p1", 1000, 0, kv);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(Infinity);
  });

  it("token 累加未超限允许", async () => {
    await checkPlatformTpm("p1", 1000, 400, kv);
    const result = await checkPlatformTpm("p1", 1000, 400, kv);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(200); // 1000 - 400 - 400 = 200
  });

  it("token 累加超限拒绝", async () => {
    await checkPlatformTpm("p1", 1000, 400, kv);
    await checkPlatformTpm("p1", 1000, 400, kv); // total=800
    const result = await checkPlatformTpm("p1", 1000, 300, kv); // 800+300=1100 >= 1000
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });
});

// ==================== checkApiKeyRpm ====================

describe("checkApiKeyRpm", () => {
  let kv: KVNamespace;
  beforeEach(() => {
    kv = makeKv();
  });

  it("rpmLimit=null 时不限制", async () => {
    const result = await checkApiKeyRpm("k1", null, kv);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(Infinity);
  });

  it("正常递增计数", async () => {
    const r1 = await checkApiKeyRpm("k1", 10, kv);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(8);

    const r2 = await checkApiKeyRpm("k1", 10, kv);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(7);
  });

  it("达到缓冲阈值拒绝", async () => {
    // rpmLimit=2，count >= 1 时拒绝
    await checkApiKeyRpm("k1", 2, kv); // count 0→1
    const result = await checkApiKeyRpm("k1", 2, kv); // count=1 >= 2-1=1 → 拒绝
    expect(result.allowed).toBe(false);
  });
});

// ==================== checkApiKeyTpm ====================

describe("checkApiKeyTpm", () => {
  let kv: KVNamespace;
  beforeEach(() => {
    kv = makeKv();
  });

  it("tpmLimit=null 时不限制", async () => {
    const result = await checkApiKeyTpm("k1", null, 100, kv);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(Infinity);
  });

  it("token 累加超限拒绝", async () => {
    await checkApiKeyTpm("k1", 500, 200, kv); // total=200
    await checkApiKeyTpm("k1", 500, 200, kv); // total=400
    const result = await checkApiKeyTpm("k1", 500, 200, kv); // 400+200=600 >= 500
    expect(result.allowed).toBe(false);
  });

  it("不同 key 独立计数", async () => {
    await checkApiKeyTpm("k1", 500, 400, kv);
    const result = await checkApiKeyTpm("k2", 500, 400, kv);
    expect(result.allowed).toBe(true);
  });
});
