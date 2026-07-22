/**
 * CRUD 操作集成测试
 *
 * 通过 mock D1 验证 Drizzle ORM 的增删改查操作
 * 能否正常通过统一的 createDb() 接口工作。
 */

import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as schema from "../schema";

// ==================== Mock D1 ====================

function createRecordingD1() {
  const calls: Array<{ sql: string; params: any[] }> = [];

  return {
    calls,
    prepare(sql: string) {
      const stmt = {
        sql,
        params: [] as any[],
        bind(...params: any[]) {
          stmt.params = params;
          return stmt;
        },
        async first() {
          calls.push({ sql, params: stmt.params });
          return null;
        },
        async all() {
          calls.push({ sql, params: stmt.params });
          return { results: [], success: true };
        },
        async run() {
          calls.push({ sql, params: stmt.params });
          return { success: true, meta: { changes: 1 } };
        },
        async raw() {
          calls.push({ sql, params: stmt.params });
          return [];
        },
      };
      return stmt;
    },
    async exec(sql: string) {
      calls.push({ sql, params: [] });
      return { success: true, results: [] };
    },
    async batch(stmts: any[]) {
      for (const s of stmts) {
        calls.push({ sql: "batch", params: [] });
      }
      return stmts.map(() => ({ success: true, meta: { changes: 0 } }));
    },
    async dump() {
      return new ArrayBuffer(0);
    },
  };
}

// ==================== 测试 ====================

describe("CRUD: 管理员表 (admins)", () => {
  let d1: ReturnType<typeof createRecordingD1>;

  beforeEach(() => {
    d1 = createRecordingD1();
  });

  it("可以构建 SELECT 查询", async () => {
    const { createDb } = await import("../database");
    const db = await createDb(d1 as any);

    const query = db
      .select({
        id: schema.admins.id,
        username: schema.admins.username,
      })
      .from(schema.admins);

    expect(query).toBeDefined();
    expect(query.where).toBeDefined();
    expect(query.limit).toBeDefined();
  });

  it("可以构建 INSERT 语句", async () => {
    const { createDb } = await import("../database");
    const db = await createDb(d1 as any);

    const insertStmt = db.insert(schema.admins).values({
      id: "test-id",
      username: "testuser",
      passwordHash: "hash123",
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
    });

    expect(insertStmt).toBeDefined();
  });

  it("可以构建 UPDATE 语句", async () => {
    const { createDb } = await import("../database");
    const db = await createDb(d1 as any);

    const updateStmt = db
      .update(schema.admins)
      .set({ username: "newname" })
      .where(eq(schema.admins.id, "test-id"));

    expect(updateStmt).toBeDefined();
  });

  it("可以构建 DELETE 语句", async () => {
    const { createDb } = await import("../database");
    const db = await createDb(d1 as any);

    const deleteStmt = db
      .delete(schema.admins)
      .where(eq(schema.admins.id, "test-id"));

    expect(deleteStmt).toBeDefined();
  });
});

describe("CRUD: API 密钥表 (api_keys)", () => {
  let d1: ReturnType<typeof createRecordingD1>;

  beforeEach(() => {
    d1 = createRecordingD1();
  });

  it("可以构建带条件的 SELECT 查询", async () => {
    const { createDb } = await import("../database");
    const db = await createDb(d1 as any);

    const query = db
      .select({
        id: schema.apiKeys.id,
        key: schema.apiKeys.key,
        name: schema.apiKeys.name,
        status: schema.apiKeys.status,
      })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.key, "test-key"))
      .limit(1);

    expect(query).toBeDefined();
  });

  it("可以构建批量 INSERT", async () => {
    const { createDb } = await import("../database");
    const db = await createDb(d1 as any);

    const now = Math.floor(Date.now() / 1000);
    const insertStmt = db.insert(schema.apiKeys).values([
      {
        id: "key-1",
        key: "sk-test-1",
        name: "Key 1",
        usedTokens: 0,
        callUsed: 0,
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "key-2",
        key: "sk-test-2",
        name: "Key 2",
        usedTokens: 0,
        callUsed: 0,
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    ]);

    expect(insertStmt).toBeDefined();
  });
});

describe("CRUD: 请求日志表 (request_logs)", () => {
  let d1: ReturnType<typeof createRecordingD1>;

  beforeEach(() => {
    d1 = createRecordingD1();
  });

  it("可以构建复杂的 SELECT + WHERE + ORDER BY", async () => {
    const { createDb } = await import("../database");
    const db = await createDb(d1 as any);

    const query = db
      .select({
        id: schema.requestLogs.id,
        model: schema.requestLogs.model,
        status: schema.requestLogs.status,
        latency: schema.requestLogs.latency,
      })
      .from(schema.requestLogs)
      .where(eq(schema.requestLogs.keyId, "key-1"))
      .orderBy(schema.requestLogs.createdAt);

    expect(query).toBeDefined();
  });

  it("可以构建 INSERT（21 列的宽表）", async () => {
    const { createDb } = await import("../database");
    const db = await createDb(d1 as any);

    const now = Math.floor(Date.now() / 1000);
    const insertStmt = db.insert(schema.requestLogs).values({
      id: "log-1",
      keyId: "key-1",
      keyName: "Test Key",
      platformId: "platform-1",
      model: "gpt-4",
      endpoint: "/v1/chat/completions",
      method: "POST",
      status: 200,
      latency: 1500,
      tokens: 100,
      promptTokens: 50,
      completionTokens: 50,
      ttft: 200,
      cost: 0.001,
      isError: false,
      createdAt: now,
    });

    expect(insertStmt).toBeDefined();
  });
});

describe("CRUD: 平台表 (platforms)", () => {
  let d1: ReturnType<typeof createRecordingD1>;

  beforeEach(() => {
    d1 = createRecordingD1();
  });

  it("可以构建 INSERT + JSON 字段", async () => {
    const { createDb } = await import("../database");
    const db = await createDb(d1 as any);

    const now = Math.floor(Date.now() / 1000);
    const insertStmt = db.insert(schema.platforms).values({
      id: "platform-1",
      name: "OpenAI",
      baseUrl: "https://api.openai.com",
      apiKey: "sk-xxx",
      apiKeys: JSON.stringify([{ name: "default", key: "sk-xxx" }]),
      type: "openai",
      enabled: true,
      priority: 0,
      weight: 1,
      status: "healthy",
      failCount: 0,
      forwardHeaders: "[]",
      createdAt: now,
      updatedAt: now,
    });

    expect(insertStmt).toBeDefined();
  });

  it("可以构建带 SQL 模板的 UPDATE（递增 failCount）", async () => {
    const { createDb } = await import("../database");
    const db = await createDb(d1 as any);

    const updateStmt = db
      .update(schema.platforms)
      .set({
        failCount: sql`${schema.platforms.failCount} + 1`,
        updatedAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(schema.platforms.id, "platform-1"));

    expect(updateStmt).toBeDefined();
  });
});

describe("CRUD: 多表关联查询", () => {
  let d1: ReturnType<typeof createRecordingD1>;

  beforeEach(() => {
    d1 = createRecordingD1();
  });

  it("可以构建 LEFT JOIN 查询（代理池 + 代理）", async () => {
    const { createDb } = await import("../database");
    const db = await createDb(d1 as any);

    const query = db
      .select({
        poolId: schema.proxyPools.id,
        poolName: schema.proxyPools.name,
        proxyId: schema.proxies.id,
        proxyAddress: schema.proxies.address,
      })
      .from(schema.proxyPools)
      .leftJoin(
        schema.proxies,
        eq(schema.proxyPools.id, schema.proxies.poolId)
      );

    expect(query).toBeDefined();
  });
});
