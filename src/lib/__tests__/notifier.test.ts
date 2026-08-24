/**
 * 告警通知模块单元测试
 *
 * 覆盖：配置解析校验（strict/宽松/默认值）、冷却去重、事件开关、
 * 禁用态与无通道时不发请求。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getConfigMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("../../../worker/src/config", () => ({
  getConfig: (...args: unknown[]) => getConfigMock(...args),
}));

// batched-writer 引入 prisma 依赖链，测试中 mock 掉绑定获取
vi.mock("../../../worker/src/batched-writer", () => ({
  getBatchedWriterBindings: () => null,
}));

import {
  NOTIFICATIONS_CONFIG_KEY,
  parseNotificationsConfig,
  serializeNotificationsConfig,
  sendNotification,
  resetNotifierForTests,
} from "../notifier";

function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    channels: [{ name: "tg", url: "https://example.com/hook" }],
    events: { keyBanned: true, platformOpen: true, platformDegraded: false, allUnavailable: true, quotaThreshold: true },
    cooldownMinutes: 10,
    ...overrides,
  };
}

describe("parseNotificationsConfig", () => {
  it("空输入返回禁用默认值", () => {
    const c = parseNotificationsConfig(null);
    expect(c.enabled).toBe(false);
    expect(c.channels).toEqual([]);
    expect(c.cooldownMinutes).toBe(10);
    expect(c.events.keyBanned).toBe(true);
    expect(c.events.platformDegraded).toBe(false);
  });

  it("解析合法配置", () => {
    const c = parseNotificationsConfig(JSON.stringify(validConfig()));
    expect(c.enabled).toBe(true);
    expect(c.channels).toEqual([{ name: "tg", url: "https://example.com/hook" }]);
  });

  it("非法 JSON：strict 抛错，宽松回退默认", () => {
    expect(() => parseNotificationsConfig("{bad", { strict: true })).toThrow();
    expect(parseNotificationsConfig("{bad").enabled).toBe(false);
  });

  it("非 http(s) URL：strict 抛错，宽松跳过该通道", () => {
    const bad = JSON.stringify(validConfig({ channels: [{ name: "x", url: "ftp://a" }, { name: "y", url: "https://ok" }] }));
    expect(() => parseNotificationsConfig(bad, { strict: true })).toThrow();
    expect(parseNotificationsConfig(bad).channels.map((c) => c.name)).toEqual(["y"]);
  });

  it("通道数超上限拒绝", () => {
    const channels = Array.from({ length: 21 }, (_, i) => ({ name: `c${i}`, url: "https://x" }));
    expect(() => parseNotificationsConfig(JSON.stringify(validConfig({ channels })), { strict: true })).toThrow(/上限/);
  });

  it("cooldownMinutes 越界：strict 抛错，宽松回退默认", () => {
    const bad = JSON.stringify(validConfig({ cooldownMinutes: 0 }));
    expect(() => parseNotificationsConfig(bad, { strict: true })).toThrow();
    expect(parseNotificationsConfig(bad).cooldownMinutes).toBe(10);
  });

  it("serialize 往返一致", () => {
    const raw = JSON.stringify(validConfig());
    expect(serializeNotificationsConfig(parseNotificationsConfig(raw))).toBe(
      serializeNotificationsConfig(parseNotificationsConfig(raw))
    );
  });
});

describe("sendNotification", () => {
  beforeEach(() => {
    resetNotifierForTests();
    getConfigMock.mockReset();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("禁用态不发请求", async () => {
    getConfigMock.mockResolvedValue(JSON.stringify(validConfig({ enabled: false })));
    await sendNotification("key_banned", "t", "b", { db: {} as never });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("事件开关关闭不发请求", async () => {
    getConfigMock.mockResolvedValue(
      JSON.stringify(validConfig({ events: { keyBanned: false, platformOpen: true, platformDegraded: false, allUnavailable: true, quotaThreshold: true } }))
    );
    await sendNotification("key_banned", "t", "b", { db: {} as never });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("启用时按配置 POST 到所有通道，payload 含 event/title/body/timestamp", async () => {
    getConfigMock.mockResolvedValue(
      JSON.stringify(validConfig({ channels: [
        { name: "a", url: "https://a.example/hook" },
        { name: "b", url: "https://b.example/hook" },
      ] }))
    );
    await sendNotification("platform_open", "标题", "正文", { db: {} as never });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://a.example/hook");
    expect(init.method).toBe("POST");
    const payload = JSON.parse(init.body);
    expect(payload.event).toBe("platform_open");
    expect(payload.title).toBe("标题");
    expect(payload.body).toBe("正文");
    expect(typeof payload.timestamp).toBe("number");
  });

  it("同类事件在冷却窗口内去重（不同 eventKey 互不影响）", async () => {
    getConfigMock.mockResolvedValue(JSON.stringify(validConfig({ cooldownMinutes: 10 })));
    const db = {} as never;
    await sendNotification("key_banned", "t", "b", { db, eventKey: "p1" });
    await sendNotification("key_banned", "t", "b", { db, eventKey: "p1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await sendNotification("key_banned", "t", "b", { db, eventKey: "p2" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("读取配置抛错时不发请求且不向外抛异常", async () => {
    getConfigMock.mockRejectedValue(new Error("db down"));
    await expect(sendNotification("key_banned", "t", "b", { db: {} as never })).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("配置键为 system:notifications", () => {
    expect(NOTIFICATIONS_CONFIG_KEY).toBe("system:notifications");
  });
});
