/**
 * 定时备份任务单元测试
 *
 * 重点：强制加密门控（未配 BACKUP_ENCRYPTION_KEY 拒绝推送）、
 * 未配置推送端跳过、加密集信封可解密回读原文。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());

import { runBackupTask } from "../backup";
import { buildConfigBackup } from "../backup-builder";

// 最小 Prisma 形状 stub：builder 只用 findMany
function stubDb() {
  return {
    platforms: { findMany: async () => [] },
    modelMappings: { findMany: async () => [] },
    platformModels: { findMany: async () => [] },
    configs: { findMany: async () => [{ key: "system:x", value: "{}" }] },
    apiKeys: { findMany: async () => [] },
  } as never;
}

describe("backup-builder", () => {
  it("config-backup 含系统级四表 + apiKeys，不含日志/统计/审计", async () => {
    const snap = await buildConfigBackup(stubDb());
    expect(snap.exportType).toBe("config-backup");
    expect(snap.platforms).toEqual([]);
    expect(snap.modelMaps).toEqual([]);
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
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
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
});
