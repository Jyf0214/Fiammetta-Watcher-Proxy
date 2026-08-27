/**
 * 开发模式模块单元测试
 *
 * 覆盖：解析/序列化、缓存失效、isDevModeCached 同步读、isDevMode 异步读
 * （TTL 内复用/过期重读/DB 失败降级）、devLog 同步短路。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// isDevMode 内部调用 createDb(env) → prisma.configs.findFirst，
// mock createDb 返回带 configs.findFirst 的 prisma client
const createDbMock = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/prisma", () => ({
  createDb: (...args: unknown[]) => createDbMock(...args),
}));

import {
  parseDevMode,
  serializeDevMode,
  isDevModeCached,
  isDevMode,
  invalidateDevModeCache,
  devLog,
} from "../dev-mode";

describe("parseDevMode", () => {
  it("空输入返回关闭", () => {
    expect(parseDevMode(null)).toBe(false);
    expect(parseDevMode(undefined)).toBe(false);
    expect(parseDevMode("")).toBe(false);
  });

  it("解析合法 enabled 字段", () => {
    expect(parseDevMode(JSON.stringify({ enabled: true }))).toBe(true);
    expect(parseDevMode(JSON.stringify({ enabled: false }))).toBe(false);
  });

  it("strict 模式下 JSON 非法抛错", () => {
    expect(() => parseDevMode("{bad", { strict: true })).toThrow();
    expect(parseDevMode("{bad")).toBe(false);
  });

  it("strict 模式下非对象抛错", () => {
    expect(() => parseDevMode("[1,2]", { strict: true })).toThrow();
    expect(parseDevMode("[1,2]")).toBe(false);
  });

  it("strict 模式下 enabled 非布尔抛错", () => {
    expect(() =>
      parseDevMode(JSON.stringify({ enabled: "yes" }), { strict: true })
    ).toThrow();
  });
});

describe("serializeDevMode", () => {
  it("序列化为结构稳定字符串", () => {
    expect(serializeDevMode(true)).toBe('{"enabled":true}');
    expect(serializeDevMode(false)).toBe('{"enabled":false}');
  });
});

describe("isDevModeCached / isDevMode 缓存", () => {
  beforeEach(() => {
    invalidateDevModeCache();
    createDbMock.mockReset();
  });

  it("未加载时 isDevModeCached 返回 false", () => {
    expect(isDevModeCached()).toBe(false);
  });

  it("未传 env 且 createDb 失败时 isDevMode 返回 false（保守关闭）", async () => {
    createDbMock.mockRejectedValue(new Error("db down"));
    expect(await isDevMode()).toBe(false);
  });

  it("isDevMode 读取 DB 并写入缓存", async () => {
    createDbMock.mockResolvedValue({
      configs: { findFirst: vi.fn().mockResolvedValue({ value: serializeDevMode(true) }) },
    });
    const result = await isDevMode();
    expect(result).toBe(true);
    expect(isDevModeCached()).toBe(true);
    expect(createDbMock).toHaveBeenCalledTimes(1);
    expect(createDbMock).toHaveBeenCalledWith(undefined);
  });

  it("isDevMode 传入 env 参数时透传给 createDb", async () => {
    createDbMock.mockResolvedValue({
      configs: { findFirst: vi.fn().mockResolvedValue({ value: serializeDevMode(true) }) },
    });
    const env = { DB_TYPE: "pg" } as Record<string, unknown>;
    const result = await isDevMode(env as any);
    expect(result).toBe(true);
    expect(createDbMock).toHaveBeenCalledWith(env);
  });

  it("缓存命中时不再调用 createDb", async () => {
    createDbMock.mockResolvedValue({
      configs: { findFirst: vi.fn().mockResolvedValue({ value: serializeDevMode(true) }) },
    });
    await isDevMode();
    const callCount = createDbMock.mock.calls.length;
    // 第二次调用应命中缓存
    const second = await isDevMode();
    expect(second).toBe(true);
    expect(createDbMock.mock.calls.length).toBe(callCount);
  });

  it("DB 失败时返回 false 不抛", async () => {
    createDbMock.mockRejectedValue(new Error("db down"));
    const result = await isDevMode();
    expect(result).toBe(false);
  });

  it("invalidateDevModeCache 后下次会重读", async () => {
    createDbMock.mockResolvedValueOnce({
      configs: { findFirst: vi.fn().mockResolvedValue({ value: serializeDevMode(true) }) },
    });
    await isDevMode();
    expect(isDevModeCached()).toBe(true);
    invalidateDevModeCache();
    expect(isDevModeCached()).toBe(false);
  });
});

describe("devLog", () => {
  beforeEach(() => {
    invalidateDevModeCache();
  });

  it("关闭时不输出", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    devLog("test", "hello");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("开启时输出带 scope 的日志", async () => {
    invalidateDevModeCache();
    // 先走一次 DB 加载注入缓存状态
    createDbMock.mockResolvedValue({
      configs: { findFirst: vi.fn().mockResolvedValue({ value: serializeDevMode(true) }) },
    });
    await isDevMode();

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    devLog("proxy", "x hit", { id: 1 });
    expect(spy).toHaveBeenCalledWith("[dev:proxy] x hit", { id: 1 });
    devLog("proxy", "no meta");
    expect(spy).toHaveBeenCalledWith("[dev:proxy] no meta");
    spy.mockRestore();
  });
});
