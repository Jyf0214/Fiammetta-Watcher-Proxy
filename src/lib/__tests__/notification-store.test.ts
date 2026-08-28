/**
 * notification-store 单元测试
 *
 * 覆盖：冷却去重（DB upsert）、配额一次性（按 keyId+threshold 唯一）、
 * 发送历史写入。queryHistory / purgeHistory 在提交 5 admin API 接入时补。
 *
 * Mock @/lib/prisma 的 createDb，验证各方法被以正确参数调用
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const mockCooldownsFindUnique = vi.hoisted(() => vi.fn());
const mockCooldownsUpsert = vi.hoisted(() => vi.fn());
const mockQuotaFindUnique = vi.hoisted(() => vi.fn());
const mockQuotaUpsert = vi.hoisted(() => vi.fn());
const mockQuotaDeleteMany = vi.hoisted(() => vi.fn());
const mockHistoryCreate = vi.hoisted(() => vi.fn());

const createDbMock = vi.hoisted(() => vi.fn(async () => ({
  notificationCooldowns: {
    findUnique: mockCooldownsFindUnique,
    upsert: mockCooldownsUpsert,
  },
  quotaNotified: {
    findUnique: mockQuotaFindUnique,
    upsert: mockQuotaUpsert,
    deleteMany: mockQuotaDeleteMany,
  },
  notificationHistory: {
    create: mockHistoryCreate,
  },
})));

vi.mock("@/lib/prisma", () => ({
  createDb: createDbMock,
}));

import {
  checkCooldown,
  recordSent,
  checkQuotaNotified,
  markQuotaNotified,
  clearQuotaNotified,
  recordHistory,
} from "../notification-store";

beforeEach(() => {
  vi.clearAllMocks();
  mockCooldownsUpsert.mockResolvedValue(undefined);
  mockQuotaUpsert.mockResolvedValue(undefined);
  mockQuotaDeleteMany.mockResolvedValue({ count: 0 });
  mockHistoryCreate.mockResolvedValue(undefined);
});

describe("checkCooldown", () => {
  it("无记录时返回 false（放行）", async () => {
    mockCooldownsFindUnique.mockResolvedValue(null);
    expect(await checkCooldown("key_banned:p1", 10)).toBe(false);
  });

  it("记录在冷却窗口内返回 true", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockCooldownsFindUnique.mockResolvedValue({ lastSentAt: now - 60 });
    expect(await checkCooldown("key_banned:p1", 10)).toBe(true);
  });

  it("记录已超过冷却窗口返回 false", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockCooldownsFindUnique.mockResolvedValue({ lastSentAt: now - 3600 });
    expect(await checkCooldown("key_banned:p1", 10)).toBe(false);
  });

  it("cooldownMinutes=0 短路返回 false（不查 DB）", async () => {
    expect(await checkCooldown("any", 0)).toBe(false);
    expect(mockCooldownsFindUnique).not.toHaveBeenCalled();
  });

  it("cooldownMinutes=负数 短路返回 false", async () => {
    expect(await checkCooldown("any", -5)).toBe(false);
    expect(mockCooldownsFindUnique).not.toHaveBeenCalled();
  });

  it("DB 抛错：Promise reject 冒泡（不吞错）", async () => {
    mockCooldownsFindUnique.mockRejectedValueOnce(new Error("db down"));
    await expect(checkCooldown("k", 10)).rejects.toThrow("db down");
  });
});

describe("recordSent", () => {
  it("upsert 写入当前时间戳和 eventKey", async () => {
    await recordSent("key_banned:p1");
    expect(mockCooldownsUpsert).toHaveBeenCalledTimes(1);
    const [args] = mockCooldownsUpsert.mock.calls[0];
    expect(args.where).toEqual({ eventKey: "key_banned:p1" });
    expect(typeof args.create.id).toBe("string");
    expect(args.create.eventKey).toBe("key_banned:p1");
    expect(typeof args.create.lastSentAt).toBe("number");
    expect(args.update.lastSentAt).toBe(args.create.lastSentAt);
  });

  it("upsert 抛错不抛出（旁路能力）", async () => {
    mockCooldownsUpsert.mockRejectedValueOnce(new Error("db down"));
    await expect(recordSent("k")).resolves.toBeUndefined();
  });
});

describe("checkQuotaNotified + markQuotaNotified", () => {
  it("未通知时 checkQuotaNotified 返回 false", async () => {
    mockQuotaFindUnique.mockResolvedValue(null);
    expect(await checkQuotaNotified("key-1", 80)).toBe(false);
  });

  it("已通知时 checkQuotaNotified 返回 true", async () => {
    mockQuotaFindUnique.mockResolvedValue({ id: "x" });
    expect(await checkQuotaNotified("key-1", 80)).toBe(true);
  });

  it("markQuotaNotified 使用 keyId+threshold 复合键 upsert", async () => {
    await markQuotaNotified("key-1", 95);
    const [args] = mockQuotaUpsert.mock.calls[0];
    expect(args.where).toEqual({ keyId_threshold: { keyId: "key-1", threshold: 95 } });
    expect(args.create.threshold).toBe(95);
  });

  it("三档位（80/95/100）独立 upsert", async () => {
    await markQuotaNotified("key-1", 80);
    await markQuotaNotified("key-1", 95);
    await markQuotaNotified("key-1", 100);
    expect(mockQuotaUpsert).toHaveBeenCalledTimes(3);
    expect(mockQuotaUpsert.mock.calls[0][0].where.keyId_threshold.threshold).toBe(80);
    expect(mockQuotaUpsert.mock.calls[1][0].where.keyId_threshold.threshold).toBe(95);
    expect(mockQuotaUpsert.mock.calls[2][0].where.keyId_threshold.threshold).toBe(100);
  });
});

describe("clearQuotaNotified", () => {
  it("按 keyId 删除所有档位记录", async () => {
    await clearQuotaNotified("key-1");
    expect(mockQuotaDeleteMany).toHaveBeenCalledWith({ where: { keyId: "key-1" } });
  });

  it("DB 抛错不抛出（旁路）", async () => {
    mockQuotaDeleteMany.mockRejectedValueOnce(new Error("db down"));
    await expect(clearQuotaNotified("k")).resolves.toBeUndefined();
  });
});

describe("recordHistory", () => {
  it("完整字段写入（status/httpStatus/error/size/duration）", async () => {
    await recordHistory({
      channelId: "ch-1",
      channelName: "tg",
      channelType: "telegram",
      event: "key_banned",
      title: "T",
      body: "B",
      status: "success",
      httpStatus: 200,
      sizeBytes: 100,
      durationMs: 50,
    });
    const [args] = mockHistoryCreate.mock.calls[0];
    expect(args.data.channelId).toBe("ch-1");
    expect(args.data.status).toBe("success");
    expect(args.data.httpStatus).toBe(200);
    expect(args.data.sizeBytes).toBe(100);
    expect(args.data.durationMs).toBe(50);
    expect(typeof args.data.sentAt).toBe("number");
  });

  it("httpStatus=null 路径（连接错误无响应）", async () => {
    await recordHistory({
      channelId: "ch-1",
      channelName: "tg",
      channelType: "telegram",
      event: "key_banned",
      title: "T",
      body: "B",
      status: "failed",
      httpStatus: null,
      error: "aborted",
      durationMs: 100,
    });
    const [args] = mockHistoryCreate.mock.calls[0];
    expect(args.data.httpStatus).toBeNull();
    expect(args.data.error).toBe("aborted");
  });

  it("缺省 sizeBytes 走 0", async () => {
    await recordHistory({
      channelId: "ch-1", channelName: "tg", channelType: "telegram",
      event: "x", title: "t", body: "b", status: "success", durationMs: 5,
    });
    const [args] = mockHistoryCreate.mock.calls[0];
    expect(args.data.sizeBytes).toBe(0);
  });

  it("DB 抛错不抛出（旁路写入）", async () => {
    mockHistoryCreate.mockRejectedValueOnce(new Error("db down"));
    await expect(
      recordHistory({
        channelId: "ch-1", channelName: "tg", channelType: "telegram",
        event: "x", title: "t", body: "b", status: "failed", durationMs: 0,
      })
    ).resolves.toBeUndefined();
  });
});
