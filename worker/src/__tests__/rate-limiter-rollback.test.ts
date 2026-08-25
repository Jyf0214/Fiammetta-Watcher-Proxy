/**
 * rate-limiter.ts 回滚函数跨窗口边界测试
 *
 * 覆盖 releasePlatformRpm / releasePlatformTpm 的 windowStart 参数语义：
 * - 传入扣减时刻 windowStart：回滚只作用于该（旧）窗口计数桶，新窗口桶不变
 * - 未传 windowStart：按归还时刻现算窗口键（历史行为，向后兼容）
 * - 目标桶不存在时 no-op，不产生写入
 *
 * 场景背景：扣减发生在窗口末尾、KV 读改写往返跨过分钟边界时，若按归还
 * 时刻现算窗口键会误减新窗口计数（凭空放行下一窗口配额），旧窗口的
 * 扣减则永久滞留。
 *
 * 使用内存 Map 模拟 KVNamespace（与 rate-limiter.test.ts 同风格）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  checkPlatformRpm,
  releasePlatformRpm,
  checkPlatformTpm,
  releasePlatformTpm,
} from "../rate-limiter";

const WINDOW_MS = 60_000;

/** 内存 KV mock，额外暴露 store 以便直接读取桶值断言 */
function makeKv(): { kv: KVNamespace; store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({ keys: [], list_complete: true }),
  } as unknown as KVNamespace;
  return { kv, store };
}

const rpmKey = (id: string, ws: number) => `rate:platform:${id}:${ws}`;
const tpmKey = (id: string, ws: number) => `tpm:platform:${id}:${ws}`;

// ==================== releasePlatformRpm ====================

describe("releasePlatformRpm 跨窗口边界回滚", () => {
  let kv: KVNamespace;
  let store: Map<string, string>;
  beforeEach(() => {
    ({ kv, store } = makeKv());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("传入扣减时刻 windowStart：只减旧窗口桶，新窗口桶不变", async () => {
    const oldWs = 1_700_000_000_000; // 扣减所在（旧）窗口
    const newWs = oldWs + WINDOW_MS; // 归还时刻已进入的新窗口
    await kv.put(rpmKey("p1", oldWs), "3");
    await kv.put(rpmKey("p1", newWs), "7");

    await releasePlatformRpm("p1", 10, kv, oldWs);

    expect(store.get(rpmKey("p1", oldWs))).toBe("2");
    expect(store.get(rpmKey("p1", newWs))).toBe("7");
  });

  it("mock 时间模拟跨分钟边界：check 在窗口 A 扣减、release 时已进入窗口 B，传扣减时刻 windowStart 后旧窗桶回落、新窗桶不被误减", async () => {
    // 窗口 A 内靠后时刻（xx 分 59.5 秒），checkPlatformRpm 正常扣减
    const t1 = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS + 59_500;
    const wsA = Math.floor(t1 / WINDOW_MS) * WINDOW_MS;
    const spy = vi.spyOn(Date, "now").mockReturnValue(t1);
    await checkPlatformRpm("p1", 10, kv);
    expect(store.get(rpmKey("p1", wsA))).toBe("1");

    // KV 往返跨过分钟边界进入窗口 B，且窗口 B 已有其他请求的计数
    const wsB = wsA + WINDOW_MS;
    await kv.put(rpmKey("p1", wsB), "9");
    spy.mockReturnValue(t1 + 10_000);

    // 调用方传入扣减时刻的 windowStart → 必须定位旧窗桶
    await releasePlatformRpm("p1", 10, kv, wsA);

    expect(store.get(rpmKey("p1", wsA))).toBe("0");
    expect(store.get(rpmKey("p1", wsB))).toBe("9");
  });

  it("未传 windowStart：保持历史行为，按归还时刻现算窗口键递减当前窗口桶", async () => {
    const nowWs = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
    await kv.put(rpmKey("p1", nowWs), "5");

    await releasePlatformRpm("p1", 10, kv);

    expect(store.get(rpmKey("p1", nowWs))).toBe("4");
  });

  it("传入的 windowStart 对应桶不存在时不产生写入", async () => {
    await releasePlatformRpm("p1", 10, kv, 1_700_000_000_000);
    expect(store.size).toBe(0);
  });
});

// ==================== releasePlatformTpm ====================

describe("releasePlatformTpm 跨窗口边界回滚", () => {
  let kv: KVNamespace;
  let store: Map<string, string>;
  beforeEach(() => {
    ({ kv, store } = makeKv());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("传入扣减时刻 windowStart：只减旧窗口桶 token，新窗口桶不变", async () => {
    const oldWs = 1_700_000_000_000;
    const newWs = oldWs + WINDOW_MS;
    await kv.put(tpmKey("p1", oldWs), "5000");
    await kv.put(tpmKey("p1", newWs), "8000");

    await releasePlatformTpm("p1", 10000, 1200, kv, oldWs);

    expect(store.get(tpmKey("p1", oldWs))).toBe("3800");
    expect(store.get(tpmKey("p1", newWs))).toBe("8000");
  });

  it("mock 时间模拟跨分钟边界：check 在窗口 A 扣减、release 时已进入窗口 B，传扣减时刻 windowStart 后旧窗桶回落、新窗桶不被误减", async () => {
    const t1 = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS + 59_500;
    const wsA = Math.floor(t1 / WINDOW_MS) * WINDOW_MS;
    const spy = vi.spyOn(Date, "now").mockReturnValue(t1);
    await checkPlatformTpm("p1", 10000, 1500, kv);
    expect(store.get(tpmKey("p1", wsA))).toBe("1500");

    const wsB = wsA + WINDOW_MS;
    await kv.put(tpmKey("p1", wsB), "9000");
    spy.mockReturnValue(t1 + 10_000);

    await releasePlatformTpm("p1", 10000, 1500, kv, wsA);

    expect(store.get(tpmKey("p1", wsA))).toBe("0");
    expect(store.get(tpmKey("p1", wsB))).toBe("9000");
  });

  it("未传 windowStart：保持历史行为，按归还时刻现算窗口键递减当前窗口桶", async () => {
    const nowWs = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
    await kv.put(tpmKey("p1", nowWs), "5000");

    await releasePlatformTpm("p1", 10000, 1200, kv);

    expect(store.get(tpmKey("p1", nowWs))).toBe("3800");
  });

  it("传入的 windowStart 对应桶不存在时不产生写入", async () => {
    await releasePlatformTpm("p1", 10000, 1200, kv, 1_700_000_000_000);
    expect(store.size).toBe(0);
  });
});
