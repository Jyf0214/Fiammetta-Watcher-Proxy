/**
 * Prisma Client 操作测试
 *
 * 验证 Prisma 生成的客户端可以正常执行增删改查操作。
 * 使用 Prisma D1 adapter + sql.js 内存数据库。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { PrismaClient } from "../../src/generated/client";
import { PrismaD1 } from "@prisma/adapter-d1";

let SQL: any;
let testDb: SqlJsDatabase;
let prisma: PrismaClient;

beforeAll(async () => {
  SQL = await initSqlJs();
  testDb = new SQL.Database();

  // 创建测试表（与 Prisma schema 一致）
  testDb.run(`
    CREATE TABLE IF NOT EXISTS admins (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      plan_id TEXT, quota REAL, used_tokens INTEGER NOT NULL DEFAULT 0,
      token_limit INTEGER, rpm_limit INTEGER, tpm_limit INTEGER,
      call_limit INTEGER, call_used INTEGER NOT NULL DEFAULT 0,
      reset_period TEXT DEFAULT 'monthly', status TEXT NOT NULL DEFAULT 'active',
      expires_at INTEGER, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS request_logs (
      id TEXT PRIMARY KEY, key_id TEXT, key_name TEXT, platform_id TEXT, proxy_id TEXT,
      model TEXT NOT NULL, endpoint TEXT, method TEXT, status INTEGER NOT NULL,
      latency INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
      ttft INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, is_error INTEGER NOT NULL DEFAULT 0,
      ip_address TEXT, user_agent TEXT, error_message TEXT, created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS platforms (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, api_key TEXT NOT NULL,
      api_keys TEXT NOT NULL DEFAULT '[]', type TEXT NOT NULL DEFAULT 'openai',
      enabled INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 0,
      weight INTEGER NOT NULL DEFAULT 1, rpm_limit INTEGER, tpm_limit INTEGER,
      forward_headers TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'healthy',
      fail_count INTEGER NOT NULL DEFAULT 0, last_fail_at INTEGER, cooldown_end INTEGER,
      created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
    );
  `);

  // 通过 sql.js D1 兼容层创建 PrismaClient
  const d1Compat = {
    prepare(sql: string) {
      return {
        bind(...params: any[]) {
          return {
            async first() {
              const s = testDb.prepare(sql);
              try { s.bind(params); return s.step() ? s.getAsObject() : null; } finally { s.free(); }
            },
            async all() {
              const s = testDb.prepare(sql);
              try { s.bind(params); const rows: any[] = []; while (s.step()) rows.push(s.getAsObject()); return { results: rows }; } finally { s.free(); }
            },
            async run() {
              const s = testDb.prepare(sql);
              try { s.bind(params); s.run(); return { success: true, meta: { changes: 0 } }; } finally { s.free(); }
            },
            async raw() {
              const s = testDb.prepare(sql);
              try { s.bind(params); const rows: any[] = []; while (s.step()) rows.push(s.get()); return rows; } finally { s.free(); }
            },
            finalize() {},
          };
        },
        finalize() {},
      };
    },
    exec(sql: string) { testDb.run(sql); return { success: true, results: [] }; },
    batch(stmts: any[]) { return stmts.map(() => ({ success: true, meta: { changes: 0 } })); },
    dump() { return new ArrayBuffer(0); },
  } as any;

  const adapter = new PrismaD1(d1Compat);
  prisma = new PrismaClient({ adapter });
});

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (testDb) testDb.close();
});

// ==================== 测试 ====================

describe("CRUD: admins 表", () => {
  it("可以创建管理员", async () => {
    const now = Math.floor(Date.now() / 1000);
    const admin = await prisma.admins.create({
      data: { id: "test-1", username: "testuser", passwordHash: "hash123", createdAt: now, updatedAt: now },
    });
    expect(admin.id).toBe("test-1");
    expect(admin.username).toBe("testuser");
  });

  it("可以查询管理员", async () => {
    const admin = await prisma.admins.findFirst({ where: { username: "testuser" } });
    expect(admin).not.toBeNull();
    expect(admin!.id).toBe("test-1");
  });

  it("可以更新管理员", async () => {
    const updated = await prisma.admins.update({
      where: { id: "test-1" },
      data: { username: "newname" },
    });
    expect(updated.username).toBe("newname");
  });

  it("可以删除管理员", async () => {
    await prisma.admins.delete({ where: { id: "test-1" } });
    const admin = await prisma.admins.findFirst({ where: { id: "test-1" } });
    expect(admin).toBeNull();
  });
});

describe("CRUD: api_keys 表", () => {
  it("可以创建 API Key", async () => {
    const now = Math.floor(Date.now() / 1000);
    const key = await prisma.apiKeys.create({
      data: {
        id: "key-1", key: "sk-test-1", name: "Key 1",
        usedTokens: 0, callUsed: 0, status: "active",
        createdAt: now, updatedAt: now,
      },
    });
    expect(key.key).toBe("sk-test-1");
  });

  it("可以批量查询", async () => {
    const keys = await prisma.apiKeys.findMany();
    expect(keys.length).toBeGreaterThanOrEqual(1);
  });

  it("可以条件查询", async () => {
    const key = await prisma.apiKeys.findFirst({ where: { key: "sk-test-1" } });
    expect(key).not.toBeNull();
    expect(key!.name).toBe("Key 1");
  });

  it("可以更新字段", async () => {
    const updated = await prisma.apiKeys.update({
      where: { id: "key-1" },
      data: { usedTokens: { increment: 100 } },
    });
    expect(updated.usedTokens).toBe(100);
  });

  it("可以删除", async () => {
    await prisma.apiKeys.delete({ where: { id: "key-1" } });
    const key = await prisma.apiKeys.findFirst({ where: { id: "key-1" } });
    expect(key).toBeNull();
  });
});

describe("CRUD: request_logs 表", () => {
  it("可以创建请求日志（宽表 21 列）", async () => {
    const now = Math.floor(Date.now() / 1000);
    const log = await prisma.requestLogs.create({
      data: {
        id: "log-1", keyId: "key-1", keyName: "Test Key", platformId: "platform-1",
        model: "gpt-4", endpoint: "/v1/chat/completions", method: "POST",
        status: 200, latency: 1500, tokens: 100, promptTokens: 50, completionTokens: 50,
        ttft: 200, cost: 0.001, isError: false, createdAt: now,
      },
    });
    expect(log.model).toBe("gpt-4");
    expect(log.tokens).toBe(100);
  });

  it("可以条件查询 + 排序", async () => {
    const logs = await prisma.requestLogs.findMany({
      where: { keyId: "key-1" },
      orderBy: { createdAt: "desc" },
    });
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });

  it("可以 count 查询", async () => {
    const count = await prisma.requestLogs.count({ where: { keyId: "key-1" } });
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("可以清理测试数据", async () => {
    await prisma.requestLogs.deleteMany({});
    const count = await prisma.requestLogs.count();
    expect(count).toBe(0);
  });
});

describe("CRUD: platforms 表", () => {
  it("可以创建平台（含 JSON 字段）", async () => {
    const now = Math.floor(Date.now() / 1000);
    const platform = await prisma.platforms.create({
      data: {
        id: "platform-1", name: "OpenAI", baseUrl: "https://api.openai.com",
        apiKey: "sk-xxx", apiKeys: JSON.stringify([{ name: "default", key: "sk-xxx" }]),
        type: "openai", enabled: true, priority: 0, weight: 1,
        status: "healthy", failCount: 0, forwardHeaders: "[]",
        createdAt: now, updatedAt: now,
      },
    });
    expect(platform.name).toBe("OpenAI");
  });

  it("可以原子递增 failCount", async () => {
    const updated = await prisma.platforms.update({
      where: { id: "platform-1" },
      data: { failCount: { increment: 1 } },
    });
    expect(updated.failCount).toBe(1);
  });

  it("可以清理测试数据", async () => {
    await prisma.platforms.deleteMany({});
  });
});
