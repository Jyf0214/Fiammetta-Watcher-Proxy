/**
 * platform-keys 白名单 TTL 自动刷新与失败重试回归测试（A2 / W10）
 *
 * A2：白名单集合加载后，管理后台勾选/取消「白名单」需在运行期生效——
 * isKeyWhitelisted / isPlatformWhitelisted 每次调用前检查上次加载时间，
 * 超过 60s 触发后台 reload（单飞复用同一 promise，失败保留旧集合继续用）。
 * W10：loadWhitelist / loadKeyStatusFromKV 成功返回 true、失败返回 false，
 * 供入口懒加载"成功后才置位 loaded 标志"（失败下次请求重试）决策。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  loadWhitelist,
  loadKeyStatusFromKV,
  isKeyWhitelisted,
  isPlatformWhitelisted,
} from "../platform-keys";

// loadWhitelist / loadKeyStatusFromKV 内部通过 createDb 查库，
// 用按序 mockResolvedValueOnce 控制每次加载看到的数据（模拟管理后台修改白名单）
const prismaMocks = vi.hoisted(() => ({
  /** 单次 findMany 返回的平台行；null → 抛 DB 错误 */
  queue: [] as Array<Array<Record<string, unknown>> | null>,
}));

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(async () => ({
    platforms: {
      findMany: async () => {
        const next = prismaMocks.queue.shift();
        if (next === null) throw new Error("db down");
        return next ?? [];
      },
    },
  })),
}));

function platformRow(whitelisted: boolean): Record<string, unknown> {
  return {
    id: "p1",
    apiKeys: JSON.stringify([{ name: "k", key: "sk-x", whitelisted }]),
    whitelisted: false,
  };
}

/** flush 后台刷新链路上的 microtask（fake timers 下 Promise.resolve 不被 timer 阻塞） */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("白名单 TTL 自动刷新（A2）", () => {
  beforeEach(() => {
    prismaMocks.queue = [];
    vi.clearAllMocks(); // 清跨用例累计的 createDb 调用计数
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    prismaMocks.queue = [];
  });

  it("TTL 到期后 isKeyWhitelisted 触发后台刷新，白名单修改 60s 内生效", async () => {
    // 初始加载：未勾选白名单
    prismaMocks.queue.push([platformRow(false)]);
    expect(await loadWhitelist({} as D1Database, { DB_TYPE: "d1" })).toBe(true);
    expect(isKeyWhitelisted("sk-x")).toBe(false);

    // 管理后台勾选白名单；推进 60s 使 TTL 过期
    prismaMocks.queue.push([platformRow(true)]);
    vi.advanceTimersByTime(60_001);

    // 本次调用触发后台刷新（fire-and-forget，旧集合仍生效）
    expect(isKeyWhitelisted("sk-x")).toBe(false);
    await flushMicrotasks();

    // 刷新完成后后续调用生效
    expect(isKeyWhitelisted("sk-x")).toBe(true);
  });

  it("TTL 到期后 isPlatformWhitelisted 同样触发刷新", async () => {
    prismaMocks.queue.push([{ id: "p1", apiKeys: null, whitelisted: false }]);
    expect(await loadWhitelist({} as D1Database, { DB_TYPE: "d1" })).toBe(true);
    expect(isPlatformWhitelisted("p1")).toBe(false);

    prismaMocks.queue.push([{ id: "p1", apiKeys: null, whitelisted: true }]);
    vi.advanceTimersByTime(60_001);

    isPlatformWhitelisted("p1");
    await flushMicrotasks();

    expect(isPlatformWhitelisted("p1")).toBe(true);
  });

  it("TTL 未到期时不触发刷新（60s 内保持内存集合）", async () => {
    prismaMocks.queue.push([platformRow(false)]);
    expect(await loadWhitelist({} as D1Database, { DB_TYPE: "d1" })).toBe(true);

    prismaMocks.queue.push([platformRow(true)]);
    vi.advanceTimersByTime(59_999);

    // 未过 60s：不触发刷新，仍读旧集合
    isKeyWhitelisted("sk-x");
    await flushMicrotasks();
    expect(isKeyWhitelisted("sk-x")).toBe(false);
  });

  it("单飞：TTL 到期后并发多次触发只加载一次（复用同一 promise）", async () => {
    const { createDb } = await import("@/lib/prisma");
    prismaMocks.queue.push([platformRow(false)]);
    expect(await loadWhitelist({} as D1Database, { DB_TYPE: "d1" })).toBe(true);

    prismaMocks.queue.push([platformRow(true)]);
    vi.advanceTimersByTime(60_001);

    // 3 次触发共享同一后台刷新
    isKeyWhitelisted("sk-x");
    isPlatformWhitelisted("p1");
    isKeyWhitelisted("sk-x");
    await flushMicrotasks();

    // 初始加载 1 次 + TTL 刷新 1 次 = 共 2 次 createDb 调用
    expect(vi.mocked(createDb)).toHaveBeenCalledTimes(2);
    expect(isKeyWhitelisted("sk-x")).toBe(true);
  });

  it("刷新失败保留旧集合继续用，不更新加载时间，下次调用重试", async () => {
    prismaMocks.queue.push([platformRow(true)]);
    expect(await loadWhitelist({} as D1Database, { DB_TYPE: "d1" })).toBe(true);
    expect(isKeyWhitelisted("sk-x")).toBe(true);

    // 推进 60s 后首次刷新失败（DB 故障）
    prismaMocks.queue.push(null);
    vi.advanceTimersByTime(60_001);
    isKeyWhitelisted("sk-x");
    await flushMicrotasks();
    // 失败：旧集合保留，不抛错
    expect(isKeyWhitelisted("sk-x")).toBe(true);

    // 再次触发（上次失败未更新 lastLoadedAt，仍过期）→ 重试成功读到新数据
    prismaMocks.queue.push([platformRow(false)]);
    isKeyWhitelisted("sk-x");
    await flushMicrotasks();
    expect(isKeyWhitelisted("sk-x")).toBe(false);
  });
});

describe("loadWhitelist / loadKeyStatusFromKV 返回值契约（W10）", () => {
  beforeEach(() => {
    prismaMocks.queue = [];
  });

  afterEach(() => {
    prismaMocks.queue = [];
  });

  it("loadWhitelist 成功返回 true、失败返回 false（入口据此决定是否重试）", async () => {
    prismaMocks.queue.push([]);
    expect(await loadWhitelist({} as D1Database, { DB_TYPE: "d1" })).toBe(true);

    prismaMocks.queue.push(null);
    expect(await loadWhitelist({} as D1Database, { DB_TYPE: "d1" })).toBe(false);
    // 失败幂等：不抛错、集合清空重建不影响后续使用
    prismaMocks.queue.push([platformRow(true)]);
    expect(await loadWhitelist({} as D1Database, { DB_TYPE: "d1" })).toBe(true);
    expect(isKeyWhitelisted("sk-x")).toBe(true);
  });

  it("loadKeyStatusFromKV 成功返回 true、失败返回 false", async () => {
    prismaMocks.queue.push([]);
    expect(await loadKeyStatusFromKV({} as D1Database, undefined, { DB_TYPE: "d1" })).toBe(true);

    prismaMocks.queue.push(null);
    expect(await loadKeyStatusFromKV({} as D1Database, undefined, { DB_TYPE: "d1" })).toBe(false);
  });
});