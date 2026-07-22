/**
 * requestLogs 导入逻辑测试
 *
 * 验证：
 * 1. 外键校验 — keyId/platformId 不存在时置 null（避免 FOREIGN KEY 约束失败）
 * 2. duration → latency 映射
 * 3. ISO 日期 → unix 秒
 * 4. 无 model 记录被跳过
 * 5. 字段缺失时使用默认值
 * 6. 6961 条批量场景
 *
 * 使用 sql.js（纯 JS SQLite）搭建真实数据库，含 FOREIGN KEY 约束
 */

import { describe, it, expect, beforeAll } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from "sql.js";

let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initSqlJs();
});

/** 创建含外键约束的测试数据库 */
function createTestDb(): SqlJsDatabase {
  const db = new SQL.Database();
  db.run("PRAGMA foreign_keys = ON");
  db.run(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '默认 Key',
      plan_id TEXT, quota INTEGER, used_tokens INTEGER NOT NULL DEFAULT 0,
      rpm_limit INTEGER, tpm_limit INTEGER, call_limit INTEGER, call_used INTEGER NOT NULL DEFAULT 0,
      token_limit INTEGER, reset_period TEXT NOT NULL DEFAULT 'monthly', status TEXT NOT NULL DEFAULT 'active',
      expires_at INTEGER, enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS platforms (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, base_url TEXT NOT NULL, api_key TEXT NOT NULL,
      api_keys TEXT NOT NULL DEFAULT '[]', type TEXT NOT NULL DEFAULT 'openai', enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 0, weight INTEGER NOT NULL DEFAULT 1, rpm_limit INTEGER, tpm_limit INTEGER,
      forward_headers TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'healthy', fail_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS request_logs (
      id TEXT PRIMARY KEY, key_id TEXT, key_name TEXT, platform_id TEXT, proxy_id TEXT,
      model TEXT NOT NULL, endpoint TEXT, method TEXT, status INTEGER NOT NULL,
      latency INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
      ttft INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, is_error INTEGER NOT NULL DEFAULT 0,
      ip_address TEXT, user_agent TEXT, error_message TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (key_id) REFERENCES api_keys(id) ON DELETE SET NULL,
      FOREIGN KEY (platform_id) REFERENCES platforms(id) ON DELETE SET NULL
    );
  `);
  return db;
}

/** ISO 字符串或 unix 时间戳 → unix 秒 */
function toUnixSeconds(value: unknown): number {
  if (typeof value === "number" && value > 1_000_000_000) return value;
  if (typeof value === "string") {
    const ts = Math.floor(new Date(value).getTime() / 1000);
    if (!isNaN(ts) && ts > 0) return ts;
  }
  return Math.floor(Date.now() / 1000);
}

/**
 * 模拟 importRequestLogs 核心逻辑（与 import.ts 保持一致）
 * 外键校验 + duration→latency + buildValues
 */
function importRequestLogs(
  db: SqlJsDatabase,
  logs: Array<Record<string, unknown>>
): { imported: number; skipped: number } {
  let imported = 0;
  let skipped = 0;

  const validLogs = logs.filter((log) => log.model);
  skipped += logs.length - validLogs.length;

  // 校验外键
  const referencedKeyIds = [...new Set(validLogs.map((l) => l.keyId).filter(Boolean) as string[])];
  const referencedPlatformIds = [...new Set(validLogs.map((l) => l.platformId).filter(Boolean) as string[])];

  const existingKeyIds = new Set<string>();
  const existingPlatformIds = new Set<string>();

  if (referencedKeyIds.length > 0) {
    const placeholders = referencedKeyIds.map(() => "?").join(",");
    const rows = db.exec(`SELECT id FROM api_keys WHERE id IN (${placeholders})`, referencedKeyIds);
    if (rows.length > 0) rows[0].values.forEach((r) => existingKeyIds.add(r[0] as string));
  }
  if (referencedPlatformIds.length > 0) {
    const placeholders = referencedPlatformIds.map(() => "?").join(",");
    const rows = db.exec(`SELECT id FROM platforms WHERE id IN (${placeholders})`, referencedPlatformIds);
    if (rows.length > 0) rows[0].values.forEach((r) => existingPlatformIds.add(r[0] as string));
  }

  const buildValues = (log: Record<string, unknown>) => {
    const rawKeyId = (log.keyId as string) || null;
    const rawPlatformId = (log.platformId as string) || null;
    return {
      id: crypto.randomUUID(),
      keyId: rawKeyId && existingKeyIds.has(rawKeyId) ? rawKeyId : null,
      keyName: (log.keyName as string) || null,
      platformId: rawPlatformId && existingPlatformIds.has(rawPlatformId) ? rawPlatformId : null,
      proxyId: (log.proxyId as string) || null,
      model: log.model as string,
      endpoint: (log.endpoint as string) || null,
      method: (log.method as string) || null,
      status: (log.status as number) || 0,
      latency: (log.duration as number) || (log.latency as number) || 0,
      tokens: (log.tokens as number) || 0,
      promptTokens: (log.promptTokens as number) || 0,
      completionTokens: (log.completionTokens as number) || 0,
      ttft: (log.ttft as number) || 0,
      cost: (log.cost as number) || 0,
      isError: log.isError ? 1 : 0,
      ipAddress: (log.ipAddress as string) || null,
      userAgent: (log.userAgent as string) || null,
      errorMessage: (log.errorMessage as string) || null,
      createdAt: toUnixSeconds(log.createdAt),
    };
  };

  const insertSql = `INSERT INTO request_logs
    (id, key_id, key_name, platform_id, proxy_id, model, endpoint, method, status,
     latency, tokens, prompt_tokens, completion_tokens, ttft, cost, is_error,
     ip_address, user_agent, error_message, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  for (const log of validLogs) {
    const v = buildValues(log);
    try {
      db.run(insertSql, [
        v.id, v.keyId, v.keyName, v.platformId, v.proxyId, v.model,
        v.endpoint, v.method, v.status, v.latency, v.tokens, v.promptTokens,
        v.completionTokens, v.ttft, v.cost, v.isError, v.ipAddress,
        v.userAgent, v.errorMessage, v.createdAt,
      ]);
      imported++;
    } catch (err: any) {
      console.error("[test] requestLog insert failed:", err.message);
      skipped++;
    }
  }

  return { imported, skipped };
}

// ==================== 测试 ====================

describe("requestLogs 导入：外键校验", () => {
  it("keyId/platformId 存在时正常插入", () => {
    const db = createTestDb();
    db.run("INSERT INTO api_keys (id, key, name) VALUES (?, ?, ?)", ["key-001", "test-key", "Test Key"]);
    db.run("INSERT INTO platforms (id, name, base_url, api_key) VALUES (?, ?, ?, ?)", [
      "plat-001", "Test Platform", "http://test.com", "sk-test",
    ]);

    const result = importRequestLogs(db, [
      {
        keyId: "key-001", platformId: "plat-001", model: "gpt-4",
        status: 200, tokens: 100, duration: 500, createdAt: "2026-07-19T00:00:00.000Z",
      },
    ]);

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);

    const rows = db.exec("SELECT key_id, platform_id, model, latency FROM request_logs");
    expect(rows[0].values[0]).toEqual(["key-001", "plat-001", "gpt-4", 500]);
    db.close();
  });

  it("keyId/platformId 不存在时置 null（不报外键错误）", () => {
    const db = createTestDb();

    const result = importRequestLogs(db, [
      {
        keyId: "non-existent-key", platformId: "non-existent-platform", model: "gpt-4",
        status: 200, tokens: 100, duration: 500, createdAt: "2026-07-19T00:00:00.000Z",
      },
    ]);

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);

    const rows = db.exec("SELECT key_id, platform_id FROM request_logs");
    expect(rows[0].values[0]).toEqual([null, null]);
    db.close();
  });

  it("混合场景：部分 keyId 存在，部分不存在", () => {
    const db = createTestDb();
    db.run("INSERT INTO api_keys (id, key, name) VALUES (?, ?, ?)", ["key-001", "test-key", "Test Key"]);
    db.run("INSERT INTO platforms (id, name, base_url, api_key) VALUES (?, ?, ?, ?)", [
      "plat-001", "Test Platform", "http://test.com", "sk-test",
    ]);

    const result = importRequestLogs(db, [
      { keyId: "key-001", platformId: "plat-001", model: "gpt-4", status: 200, duration: 500, createdAt: "2026-07-19T00:00:00.000Z" },
      { keyId: "non-existent", platformId: "non-existent", model: "gpt-3.5", status: 200, duration: 200, createdAt: "2026-07-19T01:00:00.000Z" },
      { keyId: "key-001", platformId: "non-existent", model: "claude-3", status: 200, duration: 1000, createdAt: "2026-07-19T02:00:00.000Z" },
    ]);

    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(0);

    const rows = db.exec("SELECT key_id, platform_id, model, latency FROM request_logs ORDER BY created_at");
    expect(rows[0].values[0]).toEqual(["key-001", "plat-001", "gpt-4", 500]);
    expect(rows[0].values[1]).toEqual([null, null, "gpt-3.5", 200]);
    expect(rows[0].values[2]).toEqual(["key-001", null, "claude-3", 1000]);
    db.close();
  });
});

describe("requestLogs 导入：字段映射", () => {
  it("duration 映射为 latency", () => {
    const db = createTestDb();
    const result = importRequestLogs(db, [
      { model: "gpt-4", status: 200, duration: 16685, tokens: 788, promptTokens: 728, completionTokens: 60, createdAt: "2026-07-19T05:56:17.010Z" },
    ]);
    expect(result.imported).toBe(1);
    const rows = db.exec("SELECT latency, tokens, prompt_tokens, completion_tokens FROM request_logs");
    expect(rows[0].values[0]).toEqual([16685, 788, 728, 60]);
    db.close();
  });

  it("ISO 日期字符串转为 unix 秒", () => {
    const db = createTestDb();
    const result = importRequestLogs(db, [
      { model: "gpt-4", status: 200, duration: 100, createdAt: "2026-07-19T05:56:17.010Z" },
    ]);
    expect(result.imported).toBe(1);
    const rows = db.exec("SELECT created_at FROM request_logs");
    const expectedTs = Math.floor(new Date("2026-07-19T05:56:17.010Z").getTime() / 1000);
    expect(rows[0].values[0][0]).toBe(expectedTs);
    db.close();
  });

  it("无 model 字段的记录被跳过", () => {
    const db = createTestDb();
    const result = importRequestLogs(db, [
      { status: 200, duration: 100 },
      { model: "gpt-4", status: 200, duration: 100 },
    ]);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    db.close();
  });

  it("字段缺失时使用默认值", () => {
    const db = createTestDb();
    const result = importRequestLogs(db, [{ model: "gpt-4" }]);
    expect(result.imported).toBe(1);
    const rows = db.exec("SELECT status, latency, tokens, prompt_tokens, completion_tokens, ttft, cost, is_error FROM request_logs");
    expect(rows[0].values[0]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    db.close();
  });
});

describe("requestLogs 导入：批量场景", () => {
  it("6961 条记录 — 外键全部存在时成功", () => {
    const db = createTestDb();
    db.run("INSERT INTO api_keys (id, key, name) VALUES (?, ?, ?)", [
      "cmr98pf8c0003c901nu8icnev", "test-key", "Test Key",
    ]);
    db.run("INSERT INTO platforms (id, name, base_url, api_key) VALUES (?, ?, ?, ?)", [
      "cmrewguvw006qeo01bnj25l6w", "Platform A", "http://a.com", "sk-a",
    ]);
    db.run("INSERT INTO platforms (id, name, base_url, api_key) VALUES (?, ?, ?, ?)", [
      "cmra4pg1u0000er01k73pzpik", "Platform B", "http://b.com", "sk-b",
    ]);

    const logs: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 6961; i++) {
      logs.push({
        keyId: "cmr98pf8c0003c901nu8icnev",
        platformId: i % 2 === 0 ? "cmrewguvw006qeo01bnj25l6w" : "cmra4pg1u0000er01k73pzpik",
        model: "agnes-2.0-flash", status: 200, tokens: 788,
        promptTokens: 728, completionTokens: 60, ttft: 0,
        duration: 16685, isError: false, createdAt: "2026-07-19T05:56:17.010Z",
      });
    }

    const result = importRequestLogs(db, logs);
    expect(result.imported).toBe(6961);
    expect(result.skipped).toBe(0);

    const countResult = db.exec("SELECT COUNT(*) FROM request_logs");
    expect(countResult[0].values[0][0]).toBe(6961);
    db.close();
  });

  it("6961 条记录 — 外键全部不存在时也能成功（置 null）", () => {
    const db = createTestDb();

    const logs: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 6961; i++) {
      logs.push({
        keyId: "non-existent-key", platformId: "non-existent-platform",
        model: "gpt-4", status: 200, tokens: 100, duration: 500,
        createdAt: "2026-07-19T00:00:00.000Z",
      });
    }

    const result = importRequestLogs(db, logs);
    expect(result.imported).toBe(6961);
    expect(result.skipped).toBe(0);

    const countResult = db.exec("SELECT COUNT(*) FROM request_logs WHERE key_id IS NULL AND platform_id IS NULL");
    expect(countResult[0].values[0][0]).toBe(6961);
    db.close();
  });

  it("不开启外键约束时，旧 ID 也能插入（D1 默认行为）", () => {
    const db = new SQL.Database(); // 无 PRAGMA foreign_keys = ON
    db.run(`
      CREATE TABLE api_keys (id TEXT PRIMARY KEY, key TEXT NOT NULL, name TEXT NOT NULL);
      CREATE TABLE platforms (id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, api_key TEXT NOT NULL);
      CREATE TABLE request_logs (
        id TEXT PRIMARY KEY, key_id TEXT, key_name TEXT, platform_id TEXT, proxy_id TEXT,
        model TEXT NOT NULL, endpoint TEXT, method TEXT, status INTEGER NOT NULL,
        latency INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
        ttft INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, is_error INTEGER NOT NULL DEFAULT 0,
        ip_address TEXT, user_agent TEXT, error_message TEXT, created_at INTEGER NOT NULL,
        FOREIGN KEY (key_id) REFERENCES api_keys(id),
        FOREIGN KEY (platform_id) REFERENCES platforms(id)
      );
    `);

    // SQLite 默认不开启外键约束，旧 ID 也能插入
    const result = importRequestLogs(db, [
      { keyId: "old-id-123", platformId: "old-plat-456", model: "gpt-4", status: 200, duration: 100, createdAt: "2026-07-19T00:00:00Z" },
    ]);
    expect(result.imported).toBe(1);
    db.close();
  });
});
