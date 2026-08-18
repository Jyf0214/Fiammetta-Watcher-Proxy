/**
 * worker/src/index.ts 懒加载失败重试回归测试（W10）
 *
 * 此前 `whitelistLoaded = true` 在 await loadWhitelist 之前置位：首次请求遇
 * DB 瞬时故障后，进程生命周期内永不重试（白名单豁免与持久化禁用恢复失效）。
 * 修复后：全部加载成功才置位，任一失败保持 false、下次请求自动重试；
 * whitelistLoadPromise 单飞保证并发首个请求只加载一次。
 *
 * 通过 vi.resetModules() + 动态 import 获取全新模块实例（模块级 whitelistLoaded
 * 状态独立），每个用例从干净状态开始。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../env-sync", () => ({ syncWorkerEnv: vi.fn() }));
vi.mock("../v1-route", () => ({
  handleV1Route: vi.fn(async () => new Response("ok")),
}));
// 部分 mock：保留真实判断函数，仅替换两个加载函数以便控制成功/失败
vi.mock("../platform-keys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../platform-keys")>();
  return {
    ...actual,
    loadWhitelist: vi.fn(async () => true),
    loadKeyStatusFromKV: vi.fn(async () => true),
  };
});
vi.mock("../model-fetcher", () => ({ fetchAllPlatformModels: vi.fn() }));
vi.mock("../key-reset", () => ({ handleScheduledReset: vi.fn() }));
vi.mock("../log-archiver", () => ({ runArchiveTask: vi.fn() }));
vi.mock("../types", () => ({ classifyCronExpression: vi.fn() }));
vi.mock("@/lib/anthropic", () => ({ formatAnthropicError: vi.fn() }));

import type { Env } from "../index";

function makeEnv(): Env {
  return { DB: {} as D1Database, KV: {} as KVNamespace, DB_TYPE: "d1" } as Env;
}

function makeRequest(path = "/health"): Request {
  return new Request(`https://example.com${path}`);
}

describe("worker 入口懒加载失败重试（W10）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("首次加载失败不置位，下次请求自动重试；全部成功后不再重复加载", async () => {
    vi.resetModules();
    const index = (await import("../index")).default;
    const { loadWhitelist, loadKeyStatusFromKV } = await import("../platform-keys");
    const env = makeEnv();

    // 首次请求：两个加载均失败 → 不置位
    vi.mocked(loadWhitelist).mockResolvedValueOnce(false);
    vi.mocked(loadKeyStatusFromKV).mockResolvedValueOnce(false);
    const r1 = await index.fetch(makeRequest(), env, {} as ExecutionContext);
    expect(r1.status).toBe(200); // 加载失败不阻塞请求本身（/health 照常返回）
    expect(vi.mocked(loadWhitelist)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(loadKeyStatusFromKV)).toHaveBeenCalledTimes(1);

    // 第二次请求：重试，全部成功 → 置位
    vi.mocked(loadWhitelist).mockResolvedValueOnce(true);
    vi.mocked(loadKeyStatusFromKV).mockResolvedValueOnce(true);
    await index.fetch(makeRequest(), env, {} as ExecutionContext);
    expect(vi.mocked(loadWhitelist)).toHaveBeenCalledTimes(2);

    // 第三次请求：已置位，不再加载
    await index.fetch(makeRequest(), env, {} as ExecutionContext);
    expect(vi.mocked(loadWhitelist)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(loadKeyStatusFromKV)).toHaveBeenCalledTimes(2);
  });

  it("部分失败同样不置位：白名单成功但 Key 状态失败时下次继续重试全部", async () => {
    vi.resetModules();
    const index = (await import("../index")).default;
    const { loadWhitelist, loadKeyStatusFromKV } = await import("../platform-keys");
    const env = makeEnv();

    vi.mocked(loadWhitelist).mockResolvedValueOnce(true);
    vi.mocked(loadKeyStatusFromKV).mockResolvedValueOnce(false);
    await index.fetch(makeRequest(), env, {} as ExecutionContext);
    expect(vi.mocked(loadWhitelist)).toHaveBeenCalledTimes(1);

    // 下次请求重试（两者都重新加载）
    vi.mocked(loadWhitelist).mockResolvedValueOnce(true);
    vi.mocked(loadKeyStatusFromKV).mockResolvedValueOnce(true);
    await index.fetch(makeRequest(), env, {} as ExecutionContext);
    expect(vi.mocked(loadWhitelist)).toHaveBeenCalledTimes(2);
  });

  it("并发首个请求共享同一加载 promise（单飞，只加载一次）", async () => {
    vi.resetModules();
    const index = (await import("../index")).default;
    const { loadWhitelist } = await import("../platform-keys");
    const env = makeEnv();

    // 首个加载挂起，两个请求同时到达
    let resolveLoad!: (v: boolean) => void;
    vi.mocked(loadWhitelist).mockImplementationOnce(
      () => new Promise<boolean>((resolve) => { resolveLoad = resolve; })
    );

    const p1 = index.fetch(makeRequest(), env, {} as ExecutionContext);
    const p2 = index.fetch(makeRequest(), env, {} as ExecutionContext);
    await Promise.resolve();

    // 单飞：只创建了一次加载
    expect(vi.mocked(loadWhitelist)).toHaveBeenCalledTimes(1);

    resolveLoad(true);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    // 加载完成后不再重复加载
    await index.fetch(makeRequest(), env, {} as ExecutionContext);
    expect(vi.mocked(loadWhitelist)).toHaveBeenCalledTimes(1);
  });
});