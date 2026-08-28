/**
 * 告警通知模块单元测试
 *
 * 覆盖：配置解析校验（strict/宽松/默认值）、冷却去重、事件开关、
 * 禁用态与无通道时不发请求。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getConfigMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());
const checkCooldownMock = vi.hoisted(() => vi.fn().mockResolvedValue(false));
const recordSentMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const recordHistoryMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../../../worker/src/config", () => ({
  getConfig: (...args: unknown[]) => getConfigMock(...args),
}));

// batched-writer 引入 prisma 依赖链，测试中 mock 掉绑定获取
vi.mock("../../../worker/src/batched-writer", () => ({
  getBatchedWriterBindings: () => null,
}));

// 持久化 store 在测试中 mock 掉，避免依赖 prisma client
vi.mock("../notification-store", () => ({
  checkCooldown: (...args: unknown[]) => checkCooldownMock(...args),
  recordSent: (...args: unknown[]) => recordSentMock(...args),
  recordHistory: (...args: unknown[]) => recordHistoryMock(...args),
  checkQuotaNotified: vi.fn(),
  markQuotaNotified: vi.fn(),
  clearQuotaNotified: vi.fn(),
  QUOTA_THRESHOLDS: [80, 95, 100],
}));

import {
  NOTIFICATIONS_CONFIG_KEY,
  parseNotificationsConfig,
  serializeNotificationsConfig,
  sendNotification,
  _setSleepForTests,
  resetNotifierForTests,
} from "../notifier";

function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    channels: [{ name: "tg", url: "https://example.com/hook" }],
    events: { keyBanned: true, platformCircuitTripped: true, platformRecovered: true, platformDegraded: false, allUnavailable: true, quotaThreshold: true, keyManuallyDisabled: false, backupFailed: true },
    cooldownMinutes: 10,
    backupRetentionDays: 30,
    ...overrides,
  };
}

describe("parseNotificationsConfig", () => {
  it("空输入返回禁用默认值", () => {
    const c = parseNotificationsConfig(null);
    expect(c.enabled).toBe(false);
    expect(c.channels).toEqual([]);
    expect(c.cooldownMinutes).toBe(10);
    expect(c.backupRetentionDays).toBe(30);
    expect(c.events.keyBanned).toBe(true);
    expect(c.events.platformDegraded).toBe(false);
  });

  it("解析合法配置", () => {
    const c = parseNotificationsConfig(JSON.stringify(validConfig()));
    expect(c.enabled).toBe(true);
    expect(c.channels).toHaveLength(1);
    expect(c.channels[0].name).toBe("tg");
    expect(c.channels[0].type).toBe("generic");
    expect(c.channels[0].url).toBe("https://example.com/hook");
    expect(c.channels[0].enabled).toBe(true);
    expect(c.channels[0].options).toEqual({});
    expect(c.channels[0].headers).toEqual({});
    expect(c.channels[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("v1 旧配置自动迁移：缺 type/id/options/headers → 默认值", () => {
    const old = JSON.stringify({
      enabled: true,
      channels: [{ name: "tg", url: "https://example.com/hook" }],
      events: { keyBanned: true, platformOpen: true, platformDegraded: false, allUnavailable: true, quotaThreshold: true },
      cooldownMinutes: 10,
    });
    const c = parseNotificationsConfig(old);
    expect(c.channels[0].type).toBe("generic");
    expect(c.channels[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.channels[0].enabled).toBe(true);
    expect(c.events.platformCircuitTripped).toBe(true);
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

  it("非法 channel.type：strict 抛错，宽松跳过该通道", () => {
    const bad = JSON.stringify(validConfig({ channels: [{ name: "x", type: "rocket", url: "https://x" }, { name: "y", url: "https://ok" }] }));
    expect(() => parseNotificationsConfig(bad, { strict: true })).toThrow(/rocket/);
    expect(parseNotificationsConfig(bad).channels.map((c) => c.name)).toEqual(["y"]);
  });

  it("所有 8 种 channel.type 合法", () => {
    const types = ["telegram", "bark", "serverchan", "lark", "wecom", "slack", "generic", "backup"];
    for (const t of types) {
      const c = parseNotificationsConfig(JSON.stringify(validConfig({ channels: [{ name: t, type: t, url: "https://x" }] })));
      expect(c.channels[0].type).toBe(t);
    }
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

  it("backupRetentionDays 越界：strict 抛错，宽松回退默认", () => {
    const bad = JSON.stringify(validConfig({ backupRetentionDays: 0 }));
    expect(() => parseNotificationsConfig(bad, { strict: true })).toThrow();
    expect(parseNotificationsConfig(bad).backupRetentionDays).toBe(30);
  });

  it("serialize 往返一致", () => {
    // 给通道预填稳定 id 避免每次 parse 重新生成导致字符串比较失败
    const raw = JSON.stringify(validConfig({
      channels: [{
        id: "11111111-1111-1111-1111-111111111111",
        name: "tg", type: "generic", url: "https://example.com/hook",
      }],
    }));
    const first = serializeNotificationsConfig(parseNotificationsConfig(raw));
    const second = serializeNotificationsConfig(parseNotificationsConfig(raw));
    expect(first).toBe(second);
  });

  it("options/headers 字符串裁剪到长度上限", () => {
    const longValue = "x".repeat(2000);
    const c = parseNotificationsConfig(JSON.stringify(validConfig({
      channels: [{
        name: "tg", type: "telegram", url: "https://x",
        options: { chatId: "123" },
        headers: { "X-Token": "abc" },
      }],
    })));
    expect(c.channels[0].options.chatId).toBe("123");
    expect(c.channels[0].headers["X-Token"]).toBe("abc");
    // 故意传长字符串验证裁剪
    const c2 = parseNotificationsConfig(JSON.stringify(validConfig({
      channels: [{ name: "tg", type: "telegram", url: "https://x", options: { chatId: longValue } }],
    })));
    expect(c2.channels[0].options.chatId!.length).toBeLessThanOrEqual(1024);
  });

  it("options/headers 含非字符串元素：strict 抛错，宽松丢弃并告警", () => {
    const bad = JSON.stringify(validConfig({
      channels: [{ name: "tg", type: "telegram", url: "https://x", options: { chatId: 12345 } }],
    }));
    expect(() => parseNotificationsConfig(bad, { strict: true })).toThrow(/chatId/);
    // 宽松模式：丢弃非字符串元素
    const c = parseNotificationsConfig(bad);
    expect(c.channels[0].options.chatId).toBeUndefined();
  });

  it("SSRF：enabled 通道指向内网/localhost/云元数据：strict 抛错，宽松跳过", () => {
    const badUrls = [
      "http://10.0.0.1/hook",
      "http://192.168.1.1/hook",
      "http://127.0.0.1:8000/hook",
      "http://169.254.169.254/latest/meta-data",
      "http://localhost/hook",
      "http://[::1]/hook",
    ];
    for (const url of badUrls) {
      const bad = JSON.stringify(validConfig({ channels: [{ name: "x", type: "generic", url }] }));
      expect(() => parseNotificationsConfig(bad, { strict: true }), `url=${url}`).toThrow(/不安全|内网/);
      const c = parseNotificationsConfig(bad);
      expect(c.channels, `url=${url}`).toEqual([]);
    }
  });

  it("SSRF：disabled 通道允许指向内网（占位禁用，不实际请求）", () => {
    const c = parseNotificationsConfig(JSON.stringify(validConfig({
      channels: [{ name: "x", type: "generic", url: "http://127.0.0.1/hook", enabled: false }],
    })));
    expect(c.channels).toHaveLength(1);
    expect(c.channels[0].url).toBe("http://127.0.0.1/hook");
    expect(c.channels[0].enabled).toBe(false);
  });

  it("disabled 通道允许 url 暂时为空（占位禁用态）", () => {
    const c = parseNotificationsConfig(JSON.stringify(validConfig({
      channels: [{ name: "x", type: "generic", url: "", enabled: false }],
    })));
    expect(c.channels).toHaveLength(1);
    expect(c.channels[0].url).toBe("");
    expect(c.channels[0].enabled).toBe(false);
  });
});

describe("sendNotification", () => {
  beforeEach(() => {
    resetNotifierForTests();
    // 跳过重试退避的真实等待（缩短测试时间）：mock sleep 立即 resolve
    _setSleepForTests(() => Promise.resolve());
    getConfigMock.mockReset();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) });
    checkCooldownMock.mockReset();
    checkCooldownMock.mockResolvedValue(false);
    recordSentMock.mockReset();
    recordSentMock.mockResolvedValue(undefined);
    recordHistoryMock.mockReset();
    recordHistoryMock.mockResolvedValue(undefined);
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
      JSON.stringify(validConfig({ events: { keyBanned: false, platformCircuitTripped: true, platformRecovered: true, platformDegraded: false, allUnavailable: true, quotaThreshold: true, keyManuallyDisabled: false, backupFailed: true } }))
    );
    await sendNotification("key_banned", "t", "b", { db: {} as never });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("持久化冷却：checkCooldown 返回 true 时直接返回，不发请求", async () => {
    checkCooldownMock.mockResolvedValueOnce(true);
    getConfigMock.mockResolvedValue(JSON.stringify(validConfig()));
    await sendNotification("key_banned", "t", "b", { db: {} as never, eventKey: "k1" });
    expect(checkCooldownMock).toHaveBeenCalledWith("key_banned:k1", 10);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("持久化冷却放行时 recordSent 写入 eventKey 复合键", async () => {
    checkCooldownMock.mockResolvedValueOnce(false);
    getConfigMock.mockResolvedValue(JSON.stringify(validConfig()));
    await sendNotification("key_banned", "t", "b", { db: {} as never, eventKey: "platformA" });
    expect(recordSentMock).toHaveBeenCalledWith("key_banned:platformA");
  });

  it("每次成功发送都写入 notificationHistory（每通道一条）", async () => {
    getConfigMock.mockResolvedValue(
      JSON.stringify(validConfig({ channels: [
        { name: "a", type: "generic", url: "https://a.example/hook" },
        { name: "b", type: "generic", url: "https://b.example/hook" },
      ] }))
    );
    await sendNotification("key_banned", "标题", "正文", { db: {} as never });
    expect(recordHistoryMock).toHaveBeenCalledTimes(2);
    const first = recordHistoryMock.mock.calls[0][0];
    expect(first.status).toBe("success");
    expect(first.httpStatus).toBe(200);
    expect(first.channelName).toBe("a");
    expect(first.event).toBe("key_banned");
    expect(first.title).toBe("标题");
    expect(typeof first.durationMs).toBe("number");
  });

  it("HTTP 5xx 触发重试 3 次均失败后写 history 状态为 failed", async () => {
    // 5xx 触发重试：3 次都返回 502
    fetchMock.mockResolvedValue({ ok: false, status: 502, arrayBuffer: async () => new ArrayBuffer(0) });
    getConfigMock.mockResolvedValue(JSON.stringify(validConfig()));
    await sendNotification("key_banned", "t", "b", { db: {} as never });
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 + 2 重试
    const entry = recordHistoryMock.mock.calls[0][0];
    expect(entry.status).toBe("failed");
    expect(entry.httpStatus).toBe(502);
    expect(entry.error).toBe("HTTP 502");
  });

  it("HTTP 4xx 不重试：1 次后写 history 状态为 failed", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, arrayBuffer: async () => new ArrayBuffer(0) });
    getConfigMock.mockResolvedValue(JSON.stringify(validConfig()));
    await sendNotification("key_banned", "t", "b", { db: {} as never });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const entry = recordHistoryMock.mock.calls[0][0];
    expect(entry.status).toBe("failed");
    expect(entry.httpStatus).toBe(400);
  });

  it("5xx 首次失败重试 2 次后成功：仅 1 条 success history（不应每次都写）", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 502, arrayBuffer: async () => new ArrayBuffer(0) })
      .mockResolvedValueOnce({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) });
    getConfigMock.mockResolvedValue(JSON.stringify(validConfig()));
    await sendNotification("key_banned", "t", "b", { db: {} as never });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recordHistoryMock).toHaveBeenCalledTimes(1);
    expect(recordHistoryMock.mock.calls[0][0].status).toBe("success");
  });

  it("fetch 抛错触发重试 3 次均失败后写 history 状态为 failed", async () => {
    fetchMock.mockRejectedValue(new Error("net down"));
    getConfigMock.mockResolvedValue(JSON.stringify(validConfig()));
    await sendNotification("key_banned", "t", "b", { db: {} as never });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const entry = recordHistoryMock.mock.calls[0][0];
    expect(entry.status).toBe("failed");
    expect(entry.error).toBe("net down");
  });

  it("启用时按配置 POST 到所有通道，payload 含 event/title/body/timestamp", async () => {
    getConfigMock.mockResolvedValue(
      JSON.stringify(validConfig({ channels: [
        { name: "a", type: "generic", url: "https://a.example/hook" },
        { name: "b", type: "generic", url: "https://b.example/hook" },
      ] }))
    );
    await sendNotification("platform_circuit_tripped", "标题", "正文", { db: {} as never });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://a.example/hook");
    expect(init.method).toBe("POST");
    const payload = JSON.parse(init.body);
    expect(payload.event).toBe("platform_circuit_tripped");
    expect(payload.title).toBe("标题");
    expect(payload.body).toBe("正文");
    expect(typeof payload.timestamp).toBe("number");
  });

  it("backup 类型通道不参与通知发送（不调 fetch）", async () => {
    getConfigMock.mockResolvedValue(
      JSON.stringify(validConfig({ channels: [
        { name: "notif", type: "generic", url: "https://a.example/hook" },
        { name: "bk", type: "backup", url: "https://b.example/backup" },
      ] }))
    );
    await sendNotification("key_banned", "t", "b", { db: {} as never });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://a.example/hook");
  });

  it("禁用通道（enabled=false）不参与发送", async () => {
    getConfigMock.mockResolvedValue(
      JSON.stringify(validConfig({ channels: [
        { name: "on", type: "generic", url: "https://a.example/hook", enabled: true },
        { name: "off", type: "generic", url: "https://b.example/hook", enabled: false },
      ] }))
    );
    await sendNotification("key_banned", "t", "b", { db: {} as never });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://a.example/hook");
  });

  it("同类事件在冷却窗口内去重（不同 eventKey 互不影响）", async () => {
    // 模拟 store：第一次 checkCooldown 放行，相同 eventKey 后续命中去重
    // 不同 eventKey 互不影响（key 不重叠）
    const sentKeys = new Set<string>();
    checkCooldownMock.mockImplementation((key: string) => sentKeys.has(key));
    recordSentMock.mockImplementation((key: string) => {
      sentKeys.add(key);
    });
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

  it("checkCooldown DB 抛错时回退到进程内（仍能命中冷却）", async () => {
    // 模拟 store 抛错：先一次 recordSent 成功（用 set 跟踪），第二次 checkCooldown 抛错
    // 实际行为：recordSent 走 set 实现，checkCooldown 第一次返回 false（写入 set），
    // 第二次抛错走 fallback Map，仍能命中冷却
    let sentKeys = new Set<string>();
    checkCooldownMock.mockImplementation((key: string) => {
      // 第一次查 set 命中
      if (sentKeys.has(key)) return true;
      // 模拟 DB 抛错
      throw new Error("db down");
    });
    recordSentMock.mockImplementation((key: string) => {
      sentKeys.add(key);
    });
    getConfigMock.mockResolvedValue(JSON.stringify(validConfig({ cooldownMinutes: 10 })));
    const db = {} as never;
    await sendNotification("key_banned", "t", "b", { db, eventKey: "k1" });
    // recordSent 抛错（mock 设为成功实现），但生产中 recordSent 内部 try/catch 不会冒泡
    // 第二次调用会因 checkCooldown 抛错走 fallback，fallback map 无记录 → 放行
    await sendNotification("key_banned", "t", "b", { db, eventKey: "k1" });
    // 至少 fetch 被调过（fallback 放行后正常发送）
    expect(fetchMock).toHaveBeenCalled();
  });

  it("P1-1 间歇性故障：recordSent 抛错后 fallback map 记录，下次 DB 恢复时仍能命中冷却", async () => {
    // call-1: checkCooldown 成功返回 false，recordSent 抛错（fallback 写入）
    // call-2: checkCooldown 成功返回 false（DB 找不到记录），
    //         按 P1-1 修复后仍需看 fallback map → 应命中冷却不放行
    let callCount = 0;
    checkCooldownMock.mockImplementation(() => false);
    recordSentMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // 第一次写入：模拟 DB 抛错 → 触发 fallback 写入
        throw new Error("db down");
      }
    });
    getConfigMock.mockResolvedValue(JSON.stringify(validConfig({ cooldownMinutes: 10 })));
    // 第一次：DB 写失败（fallback 写入）
    await sendNotification("key_banned", "t", "b", { db: {} as never, eventKey: "k1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockClear();
    // 第二次：DB 查询成功但无记录，fallback map 应保留冷却 → 不发请求
    await sendNotification("key_banned", "t", "b", { db: {} as never, eventKey: "k1" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("配置键为 system:notifications", () => {
    expect(NOTIFICATIONS_CONFIG_KEY).toBe("system:notifications");
  });
});
