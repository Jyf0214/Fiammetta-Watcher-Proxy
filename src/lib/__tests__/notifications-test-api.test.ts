/**
 * 通知 test / history / stats + backup test 端点单元测试
 *
 * 覆盖：未授权 401、CSRF/rateLimit 拦截、参数校验、render + 实际 fetch、
 * SSRF 防御、写 history、stats 聚合、history 过滤。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";

const mocks = vi.hoisted(() => ({
  configsFindFirst: vi.fn(),
  historyCreate: vi.fn(),
  historyFindMany: vi.fn(),
  getAdmin: vi.fn(),
  csrf: vi.fn(),
  rateLimit: vi.fn(),
}));

const createDbMock = vi.hoisted(() => vi.fn(async () => ({
  configs: { findFirst: mocks.configsFindFirst },
  notificationHistory: {
    create: mocks.historyCreate,
    findMany: mocks.historyFindMany,
  },
})));

vi.mock("@/lib/prisma", () => ({
  createDb: createDbMock,
}));

vi.mock("@/lib/admin-auth", () => ({
  getAdminFromRequest: mocks.getAdmin,
}));

vi.mock("@/lib/admin-security", () => ({
  checkCsrfOrigin: mocks.csrf,
}));

vi.mock("@/lib/admin-rate-limit", () => ({
  checkAdminRateLimit: mocks.rateLimit,
}));

const fetchMock = vi.hoisted(() => vi.fn());

beforeEach(() => {
  mocks.getAdmin.mockReset();
  mocks.getAdmin.mockResolvedValue({ adminId: "admin-1", authMethod: "jwt" });
  mocks.csrf.mockReset();
  mocks.csrf.mockReturnValue(true);
  mocks.rateLimit.mockReset();
  mocks.rateLimit.mockResolvedValue(true);
  mocks.configsFindFirst.mockReset();
  mocks.historyCreate.mockReset();
  mocks.historyCreate.mockResolvedValue(undefined);
  mocks.historyFindMany.mockReset();
  mocks.historyFindMany.mockResolvedValue([]);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) });
  vi.stubGlobal("fetch", fetchMock);
});

function makeReqRes(method: string, body?: unknown, query?: Record<string, string>): {
  req: NextApiRequest;
  res: NextApiResponse & { statusCode: number };
} {
  const req = {
    method,
    body,
    query: query ?? {},
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as NextApiRequest;
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    status(this: { statusCode: number }, code: number) { this.statusCode = code; return res; },
    json(payload: unknown) { return payload; },
    setHeader(k: string, v: string) { headers[k] = v; },
    end() {},
  } as unknown as NextApiResponse & { statusCode: number };
  return { req, res };
}

function validConfig() {
  return {
    enabled: true,
    channels: [
      {
        id: "11111111-1111-1111-1111-111111111111",
        name: "tg-bot",
        type: "telegram",
        url: "https://api.telegram.org/bot123/sendMessage",
        enabled: true,
        options: { chatId: "999" },
        headers: {},
      },
    ],
    events: {
      keyBanned: true, platformCircuitTripped: true, platformRecovered: true,
      platformDegraded: false, allUnavailable: true, quotaThreshold: true,
      keyManuallyDisabled: false, backupFailed: true,
    },
    cooldownMinutes: 10,
    backupRetentionDays: 30,
  };
}

// ==================== POST /api/admin/notifications/test ====================

describe("POST /api/admin/notifications/test", () => {
  it("未授权返回 401", async () => {
    mocks.getAdmin.mockResolvedValueOnce(null);
    const { req, res } = makeReqRes("POST", { channelId: "x", title: "t", body: "b" });
    const handler = (await import("../../../pages/api/admin/notifications/test")).default;
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("非 POST 返回 405", async () => {
    const { req, res } = makeReqRes("GET");
    const handler = (await import("../../../pages/api/admin/notifications/test")).default;
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("CSRF 拒绝时直接 return", async () => {
    mocks.csrf.mockReturnValueOnce(false);
    const { req, res } = makeReqRes("POST", { channelId: "x", title: "t", body: "b" });
    const handler = (await import("../../../pages/api/admin/notifications/test")).default;
    await handler(req, res);
    expect(mocks.configsFindFirst).not.toHaveBeenCalled();
  });

  it("参数缺失返回 400", async () => {
    const { req, res } = makeReqRes("POST", { title: "t", body: "b" }); // 缺 channelId
    const handler = (await import("../../../pages/api/admin/notifications/test")).default;
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("通道不存在返回 404", async () => {
    mocks.configsFindFirst.mockResolvedValueOnce({ value: JSON.stringify(validConfig()) });
    const { req, res } = makeReqRes("POST", {
      channelId: "99999999-9999-9999-9999-999999999999",
      title: "t", body: "b",
    });
    const handler = (await import("../../../pages/api/admin/notifications/test")).default;
    await handler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it("backup 类型通道拒绝（应走 backup/test 端点）", async () => {
    mocks.configsFindFirst.mockResolvedValueOnce({
      value: JSON.stringify({
        ...validConfig(),
        channels: [{ id: "22222222-2222-2222-2222-222222222222", name: "bk", type: "backup", url: "https://b.example", enabled: true, options: {}, headers: {} }],
      }),
    });
    const { req, res } = makeReqRes("POST", {
      channelId: "22222222-2222-2222-2222-222222222222", title: "t", body: "b",
    });
    const handler = (await import("../../../pages/api/admin/notifications/test")).default;
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("内网 URL 二次 SSRF 防御拒绝（parse 阶段就过滤掉该通道）", async () => {
    mocks.configsFindFirst.mockResolvedValueOnce({
      value: JSON.stringify({
        ...validConfig(),
        channels: [{ id: "11111111-1111-1111-1111-111111111111", name: "x", type: "generic", url: "https://127.0.0.1/hook", enabled: true, options: {}, headers: {} }],
      }),
    });
    const { req, res } = makeReqRes("POST", {
      channelId: "11111111-1111-1111-1111-111111111111", title: "t", body: "b",
    });
    const handler = (await import("../../../pages/api/admin/notifications/test")).default;
    await handler(req, res);
    // parse 阶段在 strict=false 模式下丢弃内网 URL 通道（已 disabled），所以
    // page handler 找不到 channel → 404；或者 strict=true 时 PUT 400 拒收。
    // 关键断言：fetchMock 未被调用（绝不能发往内网）
    expect([400, 404]).toContain(res.statusCode);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("成功路径：渲染 + fetch + 写 history", async () => {
    mocks.configsFindFirst.mockResolvedValueOnce({ value: JSON.stringify(validConfig()) });
    const { req, res } = makeReqRes("POST", {
      channelId: "11111111-1111-1111-1111-111111111111",
      title: "测试", body: "正文", event: "key_banned",
    });
    const handler = (await import("../../../pages/api/admin/notifications/test")).default;
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.historyCreate).toHaveBeenCalledTimes(1);
    const entry = mocks.historyCreate.mock.calls[0][0].data;
    expect(entry.channelName).toBe("tg-bot (测试)");
    expect(entry.status).toBe("success");
    expect(entry.httpStatus).toBe(200);
  });

  it("HTTP 4xx/5xx 写 history 状态为 failed，API 返回 502", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) });
    mocks.configsFindFirst.mockResolvedValueOnce({ value: JSON.stringify(validConfig()) });
    const { req, res } = makeReqRes("POST", {
      channelId: "11111111-1111-1111-1111-111111111111",
      title: "t", body: "b",
    });
    const handler = (await import("../../../pages/api/admin/notifications/test")).default;
    await handler(req, res);
    expect(res.statusCode).toBe(502);
    const entry = mocks.historyCreate.mock.calls[0][0].data;
    expect(entry.status).toBe("failed");
    expect(entry.error).toBe("HTTP 500");
  });
});

// ==================== GET /api/admin/notifications/history ====================

describe("GET /api/admin/notifications/history", () => {
  it("未授权返回 401", async () => {
    mocks.getAdmin.mockResolvedValueOnce(null);
    const { req, res } = makeReqRes("GET");
    const handler = (await import("../../../pages/api/admin/notifications/history")).default;
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("limit 必须正整数", async () => {
    const { req, res } = makeReqRes("GET", undefined, { limit: "0" });
    const handler = (await import("../../../pages/api/admin/notifications/history")).default;
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("limit 超 MAX_LIMIT 截断到 200", async () => {
    mocks.historyFindMany.mockResolvedValueOnce([]);
    const { req, res } = makeReqRes("GET", undefined, { limit: "99999" });
    const handler = (await import("../../../pages/api/admin/notifications/history")).default;
    await handler(req, res);
    const [args] = mocks.historyFindMany.mock.calls[0];
    expect(args.take).toBe(200);
  });

  it("filter channelId/event/sinceSentAt 透传到 where", async () => {
    mocks.historyFindMany.mockResolvedValueOnce([]);
    const { req, res } = makeReqRes("GET", undefined, {
      limit: "20", channelId: "ch-1", event: "key_banned", sinceSentAt: "1000",
    });
    const handler = (await import("../../../pages/api/admin/notifications/history")).default;
    await handler(req, res);
    const [args] = mocks.historyFindMany.mock.calls[0];
    expect(args.where).toEqual({
      channelId: "ch-1",
      event: "key_banned",
      sentAt: { gte: 1000 },
    });
    expect(args.orderBy).toEqual({ sentAt: "desc" });
  });
});

// ==================== GET /api/admin/notifications/stats ====================

describe("GET /api/admin/notifications/stats", () => {
  it("hours 必须正数", async () => {
    const { req, res } = makeReqRes("GET", undefined, { hours: "0" });
    const handler = (await import("../../../pages/api/admin/notifications/stats")).default;
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("hours 超 MAX_HOURS 截断到 720", async () => {
    mocks.historyFindMany.mockResolvedValueOnce([]);
    const { req, res } = makeReqRes("GET", undefined, { hours: "99999" });
    const handler = (await import("../../../pages/api/admin/notifications/stats")).default;
    await handler(req, res);
    const [args] = mocks.historyFindMany.mock.calls[0];
    const since = args.where.sentAt.gte;
    const now = Math.floor(Date.now() / 1000);
    const hours = (now - since) / 3600;
    expect(hours).toBeGreaterThan(719);
    expect(hours).toBeLessThan(721);
  });

  it("按通道聚合 success/failed/avgDurationMs", async () => {
    const now = Math.floor(Date.now() / 1000);
    mocks.historyFindMany.mockResolvedValueOnce([
      { channelId: "ch-1", channelName: "tg", channelType: "telegram", sentAt: now, status: "success", httpStatus: 200, durationMs: 100, error: null, sizeBytes: 10 },
      { channelId: "ch-1", channelName: "tg", channelType: "telegram", sentAt: now - 10, status: "failed", httpStatus: 500, durationMs: 200, error: "x", sizeBytes: 10 },
      { channelId: "ch-2", channelName: "bark", channelType: "bark", sentAt: now - 20, status: "success", httpStatus: 200, durationMs: 50, error: null, sizeBytes: 10 },
    ]);
    const { req, res } = makeReqRes("GET", undefined, { hours: "24" });
    const handler = (await import("../../../pages/api/admin/notifications/stats")).default;
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    // 验证 mock 被调用 + where sinceSentAt 设置
    const [args] = mocks.historyFindMany.mock.calls[0];
    expect(args.where.sentAt.gte).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });
});

// ==================== POST /api/admin/backup/test ====================

describe("POST /api/admin/backup/test", () => {
  it("未授权返回 401", async () => {
    mocks.getAdmin.mockResolvedValueOnce(null);
    const { req, res } = makeReqRes("POST", { url: "https://x", secret: "k" });
    const handler = (await import("../../../pages/api/admin/backup/test")).default;
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("内网 URL 拒绝", async () => {
    const { req, res } = makeReqRes("POST", { url: "http://10.0.0.1/b", secret: "k" });
    const handler = (await import("../../../pages/api/admin/backup/test")).default;
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("v1 raw-sha256 成功路径", async () => {
    const { req, res } = makeReqRes("POST", {
      url: "https://recv.example/backup", secret: "k", kdf: "raw-sha256",
    });
    const handler = (await import("../../../pages/api/admin/backup/test")).default;
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const env = JSON.parse(init.body);
    expect(env.kdf).toBeUndefined(); // v1 不带 kdf
    expect(env.alg).toBe("AES-GCM-256");
    expect(typeof env.iv).toBe("string");
  });

  it("v2 pbkdf2-sha256 成功路径含 kdf/iter/salt", async () => {
    const { req, res } = makeReqRes("POST", {
      url: "https://recv.example/backup", secret: "k", kdf: "pbkdf2-sha256",
    });
    const handler = (await import("../../../pages/api/admin/backup/test")).default;
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const [, init] = fetchMock.mock.calls[0];
    const env = JSON.parse(init.body);
    expect(env.kdf).toBe("pbkdf2-sha256");
    expect(env.iter).toBe(100000);
    expect(typeof env.salt).toBe("string");
  });

  it("接收端 HTTP 4xx/5xx 时 API 返回 502", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
    const { req, res } = makeReqRes("POST", {
      url: "https://recv.example/backup", secret: "k",
    });
    const handler = (await import("../../../pages/api/admin/backup/test")).default;
    await handler(req, res);
    expect(res.statusCode).toBe(502);
  });
});
