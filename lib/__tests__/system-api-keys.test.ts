/**
 * 系统 API Key 认证测试
 *
 * 直接验证生产代码：
 * - src/lib/admin-system-auth.ts 的 validateSystemApiKey（Bearer 认证 + last_used_at 更新）
 * - pages/api/admin/system-keys.ts 的 generateSystemKey（密钥格式）
 * - system_api_keys 与 api_keys 表完全隔离
 *
 * 数据库使用 Prisma libSQL adapter + 内存库；createDb 经 vi.mock 注入内存库，
 * 数据读写全部经 Prisma ORM 模型 API；建表 DDL 为内存库初始化所需（固定常量，无注入面）。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { PrismaClient } from "../../src/generated/d1/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import type { NextApiRequest } from "next";
import { validateSystemApiKey } from "../../src/lib/admin-system-auth";
import { generateSystemKey } from "../../pages/api/admin/system-keys";
import { createDb } from "@/lib/prisma";

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(),
}));

const mockedCreateDb = vi.mocked(createDb);

/** 创建内存测试库（Prisma libsql adapter），建表 DDL 与 prisma/schema.d1.prisma 对齐 */
async function createTestDb(): Promise<PrismaClient> {
  const adapter = new PrismaLibSql({ url: "file::memory:" });
  const db = new PrismaClient({ adapter });

  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS system_api_keys (
      id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT 1, last_used_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_system_api_keys_key ON system_api_keys(key);
  `);
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      used_tokens INTEGER NOT NULL DEFAULT 0,
      token_limit INTEGER, rpm_limit INTEGER, tpm_limit INTEGER,
      call_limit INTEGER, call_used INTEGER NOT NULL DEFAULT 0,
      reset_period TEXT DEFAULT 'monthly', status TEXT NOT NULL DEFAULT 'active',
      expires_at INTEGER, enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  return db;
}

/** 构造带 Authorization 头的请求对象 */
function authReq(authHeader: string | null): NextApiRequest {
  return {
    headers: authHeader ? { authorization: authHeader } : {},
  } as unknown as NextApiRequest;
}

let db: PrismaClient;

beforeEach(async () => {
  db = await createTestDb();
  mockedCreateDb.mockResolvedValue(db);
});

// ==================== system_api_keys：schema 兼容性 ====================

describe("system_api_keys：schema 兼容性", () => {
  it("可以插入和查询系统 Key", async () => {
    await db.systemApiKeys.create({
      data: { id: "sys-001", key: "sk-sys-test123", name: "测试 Key", enabled: true, createdAt: 0, updatedAt: 0 },
    });
    const row = await db.systemApiKeys.findUnique({
      where: { id: "sys-001" },
      select: { id: true, key: true, name: true, enabled: true },
    });
    expect(row).toEqual({ id: "sys-001", key: "sk-sys-test123", name: "测试 Key", enabled: true });
  });

  it("key 字段唯一约束生效", async () => {
    await db.systemApiKeys.create({
      data: { id: "sys-001", key: "sk-sys-dup", name: "Key 1", enabled: true, createdAt: 0, updatedAt: 0 },
    });
    await expect(
      db.systemApiKeys.create({
        data: { id: "sys-002", key: "sk-sys-dup", name: "Key 2", enabled: true, createdAt: 0, updatedAt: 0 },
      })
    ).rejects.toThrow();
  });
});

// ==================== system_api_keys：Bearer 认证逻辑 ====================

describe("system_api_keys：Bearer 认证逻辑", () => {
  it("有效 key 返回认证结果", async () => {
    await db.systemApiKeys.create({
      data: { id: "sys-001", key: "sk-sys-valid-key", name: "开发用 Key", enabled: true, createdAt: 0, updatedAt: 0 },
    });

    const result = await validateSystemApiKey(authReq("Bearer sk-sys-valid-key"));
    expect(result).toEqual({ systemKeyId: "sys-001", name: "开发用 Key" });
  });

  it("无效 key 返回 null", async () => {
    const result = await validateSystemApiKey(authReq("Bearer sk-sys-nonexistent"));
    expect(result).toBeNull();
  });

  it("空 Authorization 头返回 null", async () => {
    expect(await validateSystemApiKey(authReq(null))).toBeNull();
    expect(await validateSystemApiKey(authReq(""))).toBeNull();
    expect(await validateSystemApiKey(authReq("Basic abc"))).toBeNull();
  });

  it("禁用的 key 返回 null", async () => {
    await db.systemApiKeys.create({
      data: { id: "sys-001", key: "sk-sys-disabled", name: "已禁用 Key", enabled: false, createdAt: 0, updatedAt: 0 },
    });

    const result = await validateSystemApiKey(authReq("Bearer sk-sys-disabled"));
    expect(result).toBeNull();
  });

  it("验证成功后更新 last_used_at", async () => {
    await db.systemApiKeys.create({
      data: { id: "sys-001", key: "sk-sys-track", name: "跟踪 Key", enabled: true, lastUsedAt: null, createdAt: 0, updatedAt: 0 },
    });

    const result = await validateSystemApiKey(authReq("Bearer sk-sys-track"));
    expect(result).not.toBeNull();

    // last_used_at 更新为异步（fire-and-forget），等待其落库
    await vi.waitFor(async () => {
      const row = await db.systemApiKeys.findUnique({ where: { id: "sys-001" }, select: { lastUsedAt: true } });
      expect(row?.lastUsedAt).toBeGreaterThan(0);
    });
  });
});

// ==================== system_api_keys：密钥格式（真实生产函数） ====================

describe("system_api_keys：密钥格式", () => {
  it("生成的 key 以 sk-sys- 开头", () => {
    const key = generateSystemKey();
    expect(key).toMatch(/^sk-sys-[0-9a-f]{48}$/);
  });

  it("生成的 key 长度为 55 字符", () => {
    const key = generateSystemKey();
    expect(key.length).toBe(55);
  });
});

// ==================== system_api_keys：与 v1 api_keys 隔离 ====================

describe("system_api_keys：与 v1 api_keys 隔离", () => {
  it("v1 api_keys 表的 key 不能通过系统认证", async () => {
    await db.apiKeys.create({
      data: { id: "v1-001", key: "sk-v1-proxy-key", name: "代理 Key", status: "active", createdAt: 0, updatedAt: 0 },
    });

    const result = await validateSystemApiKey(authReq("Bearer sk-v1-proxy-key"));
    expect(result).toBeNull();
  });

  it("系统 key 能认证，v1 key 不能", async () => {
    await db.systemApiKeys.create({
      data: { id: "sys-001", key: "sk-sys-only", name: "系统 Key", enabled: true, createdAt: 0, updatedAt: 0 },
    });
    await db.apiKeys.create({
      data: { id: "v1-001", key: "sk-v1-only", name: "v1 Key", status: "active", createdAt: 0, updatedAt: 0 },
    });

    const sysResult = await validateSystemApiKey(authReq("Bearer sk-sys-only"));
    expect(sysResult).not.toBeNull();

    const v1Result = await validateSystemApiKey(authReq("Bearer sk-v1-only"));
    expect(v1Result).toBeNull();
  });
});