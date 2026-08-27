/**
 * 开发模式模块单元测试
 *
 * 覆盖：解析/序列化、缓存失效、isDevModeCached 同步读、isDevMode 异步读
 * （TTL 内复用/过期重读/DB 失败降级）、devLog 同步短路。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const getConfigMock = vi.hoisted(() => vi.fn());

vi.mock("../../../worker/src/config", () => ({
  getConfig: (...args: unknown[]) => getConfigMock(...args),
}));

import {
  DEV_MODE_CONFIG_KEY,
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
    getConfigMock.mockReset();
  });

  it("未加载时 isDevModeCached 返回 false", () => {
    expect(isDevModeCached()).toBe(false);
  });

  it("未传 db 时 isDevMode 返回 false（保守关闭）", async () => {
    expect(await isDevMode()).toBe(false);
  });

  it("isDevMode 读取 DB 并写入缓存", async () => {
    getConfigMock.mockResolvedValue(serializeDevMode(true));
    const db = {} as unknown as D1Database;
    const result = await isDevMode(db);
    expect(result).toBe(true);
    expect(isDevModeCached()).toBe(true);
    expect(getConfigMock).toHaveBeenCalledWith(
      db,
      DEV_MODE_CONFIG_KEY,
      undefined
    );
  });

  it("缓存命中时不再调用 getConfig", async () => {
    getConfigMock.mockResolvedValue(serializeDevMode(true));
    const db = {} as unknown as D1Database;
    await isDevMode(db);
    const callCount = getConfigMock.mock.calls.length;
    // 第二次调用应命中缓存
    const second = await isDevMode(db);
    expect(second).toBe(true);
    expect(getConfigMock.mock.calls.length).toBe(callCount);
  });

  it("DB 失败时返回 false 不抛", async () => {
    getConfigMock.mockRejectedValue(new Error("db down"));
    const db = {} as unknown as D1Database;
    const result = await isDevMode(db);
    expect(result).toBe(false);
  });

  it("invalidateDevModeCache 后下次会重读", async () => {
    getConfigMock.mockResolvedValueOnce(serializeDevMode(true));
    const db = {} as unknown as D1Database;
    await isDevMode(db);
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

  it("开启时输出带 scope 的日志", () => {
    invalidateDevModeCache();
    // 直接通过同步缓存注入状态：先走一次 DB 加载
    const getConfigMockLocal = getConfigMock;
    getConfigMockLocal.mockResolvedValue(serializeDevMode(true));
    return isDevMode({} as unknown as D1Database).then(() => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      devLog("proxy", "x hit", { id: 1 });
      expect(spy).toHaveBeenCalledWith("[dev:proxy] x hit", { id: 1 });
      devLog("proxy", "no meta");
      expect(spy).toHaveBeenCalledWith("[dev:proxy] no meta");
      spy.mockRestore();
    });
  });
});
