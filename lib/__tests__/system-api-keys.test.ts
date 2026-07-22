/**
 * 系统 API Key 认证测试
 *
 * 验证：
 * 1. system_api_keys 表 schema 兼容性
 * 2. Bearer 认证逻辑（有效 key / 无效 key / 禁用 key）
 * 3. key 生成格式 sk-sys-*
 * 4. 与 api_keys 表完全隔离
 */

import { describe, it, expect, beforeAll } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from "sql.js";

let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initSqlJs();
});

function createTestDb(): SqlJsDatabase {
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE IF NOT EXISTS system_api_keys (
      id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, last_used_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_system_api_keys_key ON system_api_keys(key);

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      plan_id TEXT, quota REAL, used_tokens INTEGER NOT NULL DEFAULT 0,
      token_limit INTEGER, rpm_limit INTEGER, tpm_limit INTEGER,
      call_limit INTEGER, call_used INTEGER NOT NULL DEFAULT 0,
      reset_period TEXT DEFAULT 'monthly', status TEXT NOT NULL DEFAULT 'active',
      expires_at INTEGER, enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  return db;
}

/** 模拟 _system-auth.ts 的核心验证逻辑 */
function validateSystemApiKey(
  db: SqlJsDatabase,
  authHeader: string | null
): { systemKeyId: string; name: string } | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const key = authHeader.slice(7).trim();
  if (!key) return null;

  const rows = db.exec("SELECT id, name, enabled FROM system_api_keys WHERE key = ?", [key]);
  if (rows.length === 0 || rows[0].values.length === 0) return null;

  const [id, name, enabled] = rows[0].values[0] as [string, string, number];
  if (!enabled) return null;

  // 更新 last_used_at
  db.run("UPDATE system_api_keys SET last_used_at = ? WHERE id = ?", [Math.floor(Date.now() / 1000), id]);

  return { systemKeyId: id, name };
}

function generateSystemKey(): string {
  const array = new Uint8Array(24);
  crypto.getRandomValues(array);
  const hex = Array.from(array).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sk-sys-${hex}`;
}

// ==================== 测试 ====================

describe("system_api_keys：schema 兼容性", () => {
  it("可以插入和查询系统 Key", () => {
    const db = createTestDb();
    db.run("INSERT INTO system_api_keys (id, key, name, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [
      "sys-001", "sk-sys-test123", "测试 Key", 1, 0, 0,
    ]);
    const rows = db.exec("SELECT id, key, name, enabled FROM system_api_keys WHERE id = 'sys-001'");
    expect(rows[0].values[0]).toEqual(["sys-001", "sk-sys-test123", "测试 Key", 1]);
    db.close();
  });

  it("key 字段唯一约束生效", () => {
    const db = createTestDb();
    db.run("INSERT INTO system_api_keys (id, key, name, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [
      "sys-001", "sk-sys-dup", "Key 1", 1, 0, 0,
    ]);
    expect(() => {
      db.run("INSERT INTO system_api_keys (id, key, name, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [
        "sys-002", "sk-sys-dup", "Key 2", 1, 0, 0,
      ]);
    }).toThrow();
    db.close();
  });
});

describe("system_api_keys：Bearer 认证逻辑", () => {
  it("有效 key 返回认证结果", () => {
    const db = createTestDb();
    db.run("INSERT INTO system_api_keys (id, key, name, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [
      "sys-001", "sk-sys-valid-key", "开发用 Key", 1, 0, 0,
    ]);

    const result = validateSystemApiKey(db, "Bearer sk-sys-valid-key");
    expect(result).toEqual({ systemKeyId: "sys-001", name: "开发用 Key" });
    db.close();
  });

  it("无效 key 返回 null", () => {
    const db = createTestDb();
    const result = validateSystemApiKey(db, "Bearer sk-sys-nonexistent");
    expect(result).toBeNull();
    db.close();
  });

  it("空 Authorization 头返回 null", () => {
    const db = createTestDb();
    expect(validateSystemApiKey(db, null)).toBeNull();
    expect(validateSystemApiKey(db, "")).toBeNull();
    expect(validateSystemApiKey(db, "Basic abc")).toBeNull();
    db.close();
  });

  it("禁用的 key 返回 null", () => {
    const db = createTestDb();
    db.run("INSERT INTO system_api_keys (id, key, name, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [
      "sys-001", "sk-sys-disabled", "已禁用 Key", 0, 0, 0,
    ]);

    const result = validateSystemApiKey(db, "Bearer sk-sys-disabled");
    expect(result).toBeNull();
    db.close();
  });

  it("验证成功后更新 last_used_at", () => {
    const db = createTestDb();
    db.run("INSERT INTO system_api_keys (id, key, name, enabled, last_used_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
      "sys-001", "sk-sys-track", "跟踪 Key", 1, null, 0, 0,
    ]);

    validateSystemApiKey(db, "Bearer sk-sys-track");
    const rows = db.exec("SELECT last_used_at FROM system_api_keys WHERE id = 'sys-001'");
    expect(rows[0].values[0][0]).toBeGreaterThan(0);
    db.close();
  });
});

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

describe("system_api_keys：与 v1 api_keys 隔离", () => {
  it("v1 api_keys 表的 key 不能通过系统认证", () => {
    const db = createTestDb();
    // 在 api_keys 表插入 v1 key
    db.run("INSERT INTO api_keys (id, key, name, status, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
      "v1-001", "sk-v1-proxy-key", "代理 Key", "active", 1, 0, 0,
    ]);

    // 用 v1 key 尝试系统认证 → 失败
    const result = validateSystemApiKey(db, "Bearer sk-v1-proxy-key");
    expect(result).toBeNull();
    db.close();
  });

  it("系统 key 不能查询到 api_keys 表的数据", () => {
    const db = createTestDb();
    db.run("INSERT INTO system_api_keys (id, key, name, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [
      "sys-001", "sk-sys-only", "系统 Key", 1, 0, 0,
    ]);
    db.run("INSERT INTO api_keys (id, key, name, status, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
      "v1-001", "sk-v1-only", "v1 Key", "active", 1, 0, 0,
    ]);

    // 系统认证只能查 system_api_keys 表
    const sysResult = validateSystemApiKey(db, "Bearer sk-sys-only");
    expect(sysResult).not.toBeNull();

    // api_keys 表的 key 在系统认证中不存在
    const v1Result = validateSystemApiKey(db, "Bearer sk-v1-only");
    expect(v1Result).toBeNull();
    db.close();
  });
});
