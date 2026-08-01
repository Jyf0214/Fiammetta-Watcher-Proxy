/**
 * key-status 共享模块单元测试
 *
 * 覆盖：指纹计算、KV 键构造、状态读写与过期过滤
 */

import { describe, it, expect } from "vitest";
import {
  keyFingerprint,
  keyStatusKey,
  readPlatformKeyStatus,
  writePlatformKeyStatus,
  KEY_STATUS_PREFIX,
} from "../key-status";

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

// ==================== keyFingerprint ====================

describe("keyFingerprint", () => {
  it("相同 Key 指纹稳定", () => {
    const key = "sk-test-12345";
    expect(keyFingerprint(key)).toBe(keyFingerprint(key));
  });

  it("不同 Key 指纹不同", () => {
    expect(keyFingerprint("sk-key-a")).not.toBe(keyFingerprint("sk-key-b"));
  });

  it("指纹为 8 位十六进制", () => {
    expect(keyFingerprint("sk-any")).toMatch(/^[0-9a-f]{8}$/);
  });
});

// ==================== keyStatusKey ====================

describe("keyStatusKey", () => {
  it("使用固定前缀 + 平台 ID", () => {
    expect(keyStatusKey("p123")).toBe(`${KEY_STATUS_PREFIX}p123`);
  });
});

// ==================== readPlatformKeyStatus ====================

describe("readPlatformKeyStatus", () => {
  it("KV 无值时返回空对象", async () => {
    const kv = makeMockKv();
    expect(await readPlatformKeyStatus(kv, "p1")).toEqual({});
  });

  it("过滤已过期的状态", async () => {
    const kv = makeMockKv();
    const now = Date.now();
    kv.store.set(
      keyStatusKey("p1"),
      JSON.stringify({
        aaaa: { status: "banned", expireAt: now + 60_000 },
        bbbb: { status: "banned", expireAt: now - 1000 },
      })
    );
    const result = await readPlatformKeyStatus(kv, "p1");
    expect(Object.keys(result)).toEqual(["aaaa"]);
    expect(result.aaaa).toEqual({ status: "banned", expireAt: now + 60_000 });
  });

  it("损坏的 JSON 返回空对象", async () => {
    const kv = makeMockKv();
    kv.store.set(keyStatusKey("p1"), "{bad json");
    expect(await readPlatformKeyStatus(kv, "p1")).toEqual({});
  });
});

// ==================== writePlatformKeyStatus ====================

describe("writePlatformKeyStatus", () => {
  it("写入后可读回，且保留其他 Key 的状态", async () => {
    const kv = makeMockKv();
    const now = Date.now();

    await writePlatformKeyStatus(kv, "p1", "aaaa", {
      status: "banned",
      expireAt: now + 60_000,
    });
    await writePlatformKeyStatus(kv, "p1", "bbbb", {
      status: "deprioritized",
      expireAt: now + 30_000,
    });

    const result = await readPlatformKeyStatus(kv, "p1");
    expect(result.aaaa).toEqual({ status: "banned", expireAt: now + 60_000 });
    expect(result.bbbb).toEqual({ status: "deprioritized", expireAt: now + 30_000 });
  });
});
