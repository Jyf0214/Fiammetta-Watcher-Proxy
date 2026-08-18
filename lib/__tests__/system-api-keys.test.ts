/**
 * 系统 API Key 认证测试
 *
 * 直接验证生产代码：
 * - src/lib/admin-system-auth.ts 的 validateSystemApiKey（Bearer 认证 + last_used_at 更新）
 * - pages/api/admin/system-keys.ts 的 generateSystemKey（密钥格式）
 * - system_api_keys 与 api_keys 表完全隔离
 *
 * 数据库使用虚拟 PostgreSQL（PGlite 内存实例，仅存在于测试进程），
 * 表结构由 prisma migrate diff 从 prisma/schema.pg.prisma 派生；
 * createTestDb 经 lib/prisma 真实 createDb 工厂建立 pg 缓存后，
 * 将 PG_URL 写入 process.env，被测代码的无参 createDb() 命中同一实例。
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { NextApiRequest } from "next";
import { validateSystemApiKey } from "../../src/lib/admin-system-auth";
import { generateSystemKey } from "../../pages/api/admin/system-keys";
import { createTestDb } from "./helpers/test-pg-db";
import type { Database } from "@/lib/prisma";

/** 构造带 Authorization 头的请求对象 */
function authReq(authHeader: string | null): NextApiRequest {
  return {
    headers: authHeader ? { authorization: authHeader } : {},
  } as unknown as NextApiRequest;
}

let db: Database;
let cleanup: () => Promise<void>;
let savedPgUrl: string | undefined;
let savedDbType: string | undefined;

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  cleanup = created.cleanup;
  // 被测代码 validateSystemApiKey 内部调用无参 createDb()：显式固定方言与连接串，
  // 不隐式依赖 .env.local 内容，保证其命中本测试的虚拟库实例
  savedPgUrl = process.env.PG_URL;
  savedDbType = process.env.DB_TYPE;
  process.env.PG_URL = created.url;
  process.env.DB_TYPE = "pg";
}, 120_000);

beforeEach(async () => {
  await db.systemApiKeys.deleteMany({});
  await db.apiKeys.deleteMany({});
});

afterAll(async () => {
  if (savedPgUrl === undefined) delete process.env.PG_URL;
  else process.env.PG_URL = savedPgUrl;
  if (savedDbType === undefined) delete process.env.DB_TYPE;
  else process.env.DB_TYPE = savedDbType;
  await cleanup();
}, 120_000);

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

    // last_used_at 更新已 await（L2 修复：CF Pages 边缘运行时响应返回后不保证
    // fire-and-forget promise 继续执行），认证返回时更新必然已落库
    const row = await db.systemApiKeys.findUnique({ where: { id: "sys-001" }, select: { lastUsedAt: true } });
    expect(row?.lastUsedAt).toBeGreaterThan(0);
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