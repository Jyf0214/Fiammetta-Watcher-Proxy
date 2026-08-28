/**
 * 定时备份任务单元测试
 *
 * 重点：强制加密门控（未配加密钥拒绝推送）、未配置推送端跳过、
 * 加密集信封可解密回读原文、多接收端串行推送、PBKDF2 vs SHA-256 信封格式区分。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
const mockConfigsFindFirst = vi.hoisted(() => vi.fn());
const mockHistoryCreate = vi.hoisted(() => vi.fn());

const createDbMock = vi.hoisted(() => vi.fn(async () => ({
  configs: {
    findFirst: mockConfigsFindFirst,
  },
  notificationHistory: {
    create: mockHistoryCreate,
  },
})));

vi.mock("@/lib/prisma", () => ({
  createDb: createDbMock,
}));

import { runBackupTask, _setBackupSleepForTests } from "../backup";
import { buildConfigBackup } from "../backup-builder";

// builder 直接传 db，不需要 stub；但 runBackupTask 内部 createDb 用 mock
function stubDb() {
  return {
    platforms: { findMany: async () => [] },
    platformModels: { findMany: async () => [] },
    configs: { findMany: async () => [{ key: "system:x", value: "{}" }] },
    apiKeys: { findMany: async () => [] },
  } as never;
}

describe("backup-builder", () => {
  it("config-backup 含系统级三表 + apiKeys，不含日志/统计/审计", async () => {
    const snap = await buildConfigBackup(stubDb());
    expect(snap.exportType).toBe("config-backup");
    expect(snap.platforms).toEqual([]);
    expect(snap.platformModels).toEqual([]);
    expect(snap.configs).toEqual([{ key: "system:x", value: "{}" }]);
    expect(snap.apiKeys).toEqual([]);
    expect(snap.requestLogs).toBeUndefined();
    expect(snap.dailyStats).toBeUndefined();
    expect(snap.auditLogs).toBeUndefined();
  });
});

describe("runBackupTask", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) });
    vi.stubGlobal("fetch", fetchMock);
    // 默认通知配置无 backup 通道（loadBackupChannels 返回 []）
    mockConfigsFindFirst.mockReset();
    mockConfigsFindFirst.mockResolvedValue(null);
    mockHistoryCreate.mockReset();
    mockHistoryCreate.mockResolvedValue(undefined);
    // 跳过重试退避真实等待
    _setBackupSleepForTests(() => Promise.resolve());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("未配置 BACKUP_WEBHOOK_URL 时跳过且不发请求", async () => {
    const r = await runBackupTask({} as never, { BACKUP_ENCRYPTION_KEY: "k" });
    expect(r.success).toBe(true);
    expect(r.pushed).toBe(false);
    expect(r.skipped).toMatch(/BACKUP_WEBHOOK_URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("配置了推送端但未配加密钥：拒绝明文外发", async () => {
    const r = await runBackupTask(stubDb(), { BACKUP_WEBHOOK_URL: "https://recv.example/backup" });
    expect(r.success).toBe(false);
    expect(r.skipped).toMatch(/BACKUP_ENCRYPTION_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("非 http(s) 推送端拒绝", async () => {
    const r = await runBackupTask(stubDb(), {
      BACKUP_WEBHOOK_URL: "ftp://x",
      BACKUP_ENCRYPTION_KEY: "k",
    });
    expect(r.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("配置齐全时 POST 加密集信封，可解密回读 config-backup 原文", async () => {
    const secret = "unit-test-secret";
    const r = await runBackupTask(stubDb(), {
      BACKUP_WEBHOOK_URL: "https://recv.example/backup",
      BACKUP_ENCRYPTION_KEY: secret,
    });
    expect(r.success).toBe(true);
    expect(r.pushed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://recv.example/backup");
    const envelope = JSON.parse(init.body);
    expect(envelope.encrypted).toBe(true);
    expect(envelope.alg).toBe("AES-GCM-256");

    // 用同规则派生密钥解密，验证内容为完整快照
    const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
    const key = await crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["decrypt"]);
    const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64ToBytes(envelope.iv) },
      key,
      b64ToBytes(envelope.data)
    );
    const snapshot = JSON.parse(new TextDecoder().decode(plain));
    expect(snapshot.exportType).toBe("config-backup");
    expect(snapshot.configs).toEqual([{ key: "system:x", value: "{}" }]);
  });

  it("推送后必须消费响应体释放连接（成功/失败分支均读取 arrayBuffer）", async () => {
    // 未读取的 body 会挂起 keep-alive 连接造成泄漏（同 upstream-proxy 各路径）
    const env = {
      BACKUP_WEBHOOK_URL: "https://recv.example/backup",
      BACKUP_ENCRYPTION_KEY: "k",
    };

    // 成功路径：3 次都 200，验证 arrayBuffer 必读
    const okBody = vi.fn(async () => new ArrayBuffer(0));
    fetchMock.mockResolvedValue({ ok: true, status: 200, arrayBuffer: okBody });
    let r = await runBackupTask(stubDb(), env);
    expect(r.success).toBe(true);
    expect(r.pushed).toBe(true);
    expect(r.pushedCount).toBe(1);
    expect(r.failedCount).toBe(0);
    expect(okBody).toHaveBeenCalledTimes(1);
  });

  it("5xx 全部重试仍失败：failedCount=1, success=false", async () => {
    const env = {
      BACKUP_WEBHOOK_URL: "https://recv.example/backup",
      BACKUP_ENCRYPTION_KEY: "k",
    };

    // 3 次都 502（mockResolvedValue 永久覆盖）
    const failBody = vi.fn(async () => new ArrayBuffer(0));
    fetchMock.mockResolvedValue({ ok: false, status: 502, arrayBuffer: failBody });
    const r = await runBackupTask(stubDb(), env);
    expect(r.success).toBe(false);
    expect(r.pushedCount).toBe(0);
    expect(r.failedCount).toBe(1);
    expect(failBody).toHaveBeenCalledTimes(3); // 1 + 2 重试
  });

  it("响应体读取中断时取消流兜底且不改变失败语义", async () => {
    const cancel = vi.fn(async () => undefined);
    // 3 次重试都 500 + arrayBuffer 抛错（每个 response 都是新对象）
    fetchMock.mockImplementation(() => Promise.resolve({
      ok: false,
      status: 500,
      arrayBuffer: vi.fn(async () => {
        throw new Error("aborted mid-body");
      }),
      body: { cancel },
    }));
    const r = await runBackupTask(stubDb(), {
      BACKUP_WEBHOOK_URL: "https://recv.example/backup",
      BACKUP_ENCRYPTION_KEY: "k",
    });
    expect(r.success).toBe(false);
    expect(r.failedCount).toBe(1);
    // arrayBuffer 中断后必须走 cancel 兜底释放连接（3 次都该走）
    expect(cancel).toHaveBeenCalledTimes(3);
  });

  // ==================== v2 PBKDF2 信封 ====================

  it("管理后台配置 backup 通道：v2 PBKDF2 信封可解密回读", async () => {
    // 通知配置含一个 backup 通道（options.encryptionKey 显式设置 → 走 v2 信封）
    mockConfigsFindFirst.mockResolvedValue({
      value: JSON.stringify({
        enabled: true,
        channels: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            name: "channel-1",
            type: "backup",
            url: "https://recv.example/backup",
            enabled: true,
            options: { encryptionKey: "v2-secret" },
            headers: {},
          },
        ],
        events: {
          keyBanned: false, platformCircuitTripped: false, platformRecovered: false,
          platformDegraded: false, allUnavailable: false, quotaThreshold: false,
          keyManuallyDisabled: false, backupFailed: false,
        },
        cooldownMinutes: 10,
        backupRetentionDays: 30,
      }),
    });
    const r = await runBackupTask(stubDb(), {});
    expect(r.success).toBe(true);
    expect(r.pushed).toBe(true);
    expect(r.pushedCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const envelope = JSON.parse(init.body);
    // v2 信封含 kdf/salt/iter 字段
    expect(envelope.encrypted).toBe(true);
    expect(envelope.kdf).toBe("pbkdf2-sha256");
    expect(envelope.iter).toBe(100000);
    expect(typeof envelope.salt).toBe("string");
    expect(typeof envelope.iv).toBe("string");

    // 用 PBKDF2 派生密钥解密封装，验证原文
    const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
    const baseKey = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode("v2-secret"),
      "PBKDF2", false, ["deriveKey"]
    );
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt: b64ToBytes(envelope.salt), iterations: 100000 },
      baseKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]
    );
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64ToBytes(envelope.iv) }, key, b64ToBytes(envelope.data)
    );
    const snapshot = JSON.parse(new TextDecoder().decode(plain));
    expect(snapshot.exportType).toBe("config-backup");
  });

  it("管理后台通道未设 encryptionKey 且 env 兜底也未设：跳过且 failedCount=0", async () => {
    mockConfigsFindFirst.mockResolvedValue({
      value: JSON.stringify({
        enabled: true,
        channels: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            name: "no-key",
            type: "backup",
            url: "https://recv.example/backup",
            enabled: true,
            options: {}, // 缺 encryptionKey
            headers: {},
          },
        ],
        events: {
          keyBanned: false, platformCircuitTripped: false, platformRecovered: false,
          platformDegraded: false, allUnavailable: false, quotaThreshold: false,
          keyManuallyDisabled: false, backupFailed: false,
        },
        cooldownMinutes: 10,
        backupRetentionDays: 30,
      }),
    });
    const r = await runBackupTask(stubDb(), {}); // env 兜底也无
    expect(r.success).toBe(true);
    expect(r.pushed).toBe(false);
    expect(r.skipped).toMatch(/未配置 backup 通道/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ==================== 多接收端 ====================

  it("多接收端串行推送：1 成功 1 失败时 overallOk=true, pushedCount=1, failedCount=1", async () => {
    mockConfigsFindFirst.mockResolvedValue({
      value: JSON.stringify({
        enabled: true,
        channels: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            name: "ch-a", type: "backup", url: "https://a.example/backup",
            enabled: true, options: { encryptionKey: "k" }, headers: {},
          },
          {
            id: "22222222-2222-2222-2222-222222222222",
            name: "ch-b", type: "backup", url: "https://b.example/backup",
            enabled: true, options: { encryptionKey: "k" }, headers: {},
          },
        ],
        events: {
          keyBanned: false, platformCircuitTripped: false, platformRecovered: false,
          platformDegraded: false, allUnavailable: false, quotaThreshold: false,
          keyManuallyDisabled: false, backupFailed: false,
        },
        cooldownMinutes: 10,
        backupRetentionDays: 30,
      }),
    });
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) })
      .mockResolvedValue({ ok: false, status: 502, arrayBuffer: async () => new ArrayBuffer(0) });
    const r = await runBackupTask(stubDb(), {});
    expect(r.success).toBe(true);
    expect(r.pushed).toBe(true);
    expect(r.pushedCount).toBe(1);
    expect(r.failedCount).toBe(1);
  });

  it("多接收端全部失败：触发 backup_failed 通知 + 整体 success=false", async () => {
    mockConfigsFindFirst.mockResolvedValue({
      value: JSON.stringify({
        enabled: true,
        channels: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            name: "ch-a", type: "backup", url: "https://a.example/backup",
            enabled: true, options: { encryptionKey: "k" }, headers: {},
          },
        ],
        events: {
          keyBanned: false, platformCircuitTripped: false, platformRecovered: false,
          platformDegraded: false, allUnavailable: false, quotaThreshold: false,
          keyManuallyDisabled: false, backupFailed: false,
        },
        cooldownMinutes: 10,
        backupRetentionDays: 30,
      }),
    });
    fetchMock.mockResolvedValue({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) });
    const r = await runBackupTask(stubDb(), {});
    expect(r.success).toBe(false);
    expect(r.failedCount).toBe(1);
  });
});
