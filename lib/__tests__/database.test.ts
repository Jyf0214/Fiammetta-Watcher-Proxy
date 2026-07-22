/**
 * 数据库工厂测试
 *
 * 验证 createDb() 函数在不同配置下的行为：
 * - D1 模式：传入 mock D1Database
 * - 缺失配置时的错误处理
 * - Schema 导出完整性
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as sqliteSchema from "../schema";

// ==================== Mock D1Database ====================

/**
 * 创建一个最小化的 mock D1Database
 * 实现 Drizzle D1 adapter 所需的接口
 */
function createMockD1(): any {
  // 内存存储：表名 → 行数组
  const storage = new Map<string, any[]>();

  return {
    _storage: storage,
    prepare(sql: string) {
      const stmt = {
        _sql: sql,
        _params: [] as any[],
        bind(...params: any[]) {
          stmt._params = params;
          return stmt;
        },
        async first(colName?: string) {
          // 简单的 SELECT 匹配
          const match = sql.match(/FROM\s+(\w+)/i);
          if (!match) return null;
          const table = match[1];
          const rows = storage.get(table) || [];
          if (rows.length === 0) return null;
          const row = rows[0];
          if (colName) return row[colName] ?? null;
          return row;
        },
        async all() {
          const match = sql.match(/FROM\s+(\w+)/i);
          if (!match) return { results: [], success: true };
          const table = match[1];
          const rows = storage.get(table) || [];
          return { results: rows, success: true };
        },
        async run() {
          // INSERT 模拟
          const insertMatch = sql.match(/INSERT\s+INTO\s+(\w+)/i);
          if (insertMatch) {
            const table = insertMatch[1];
            if (!storage.has(table)) storage.set(table, []);
            // 把 params 转为简单对象存入
            const row = { _params: stmt._params };
            storage.get(table)!.push(row);
            return { success: true, meta: { changes: 1 } };
          }

          // UPDATE 模拟
          const updateMatch = sql.match(/UPDATE\s+(\w+)/i);
          if (updateMatch) {
            return { success: true, meta: { changes: 0 } };
          }

          // DELETE 模拟
          const deleteMatch = sql.match(/DELETE\s+FROM\s+(\w+)/i);
          if (deleteMatch) {
            return { success: true, meta: { changes: 0 } };
          }

          return { success: true, meta: { changes: 0 } };
        },
        async raw() {
          return [];
        },
      };
      return stmt;
    },
    async exec(sql: string) {
      return { success: true, results: [] };
    },
    async batch(stmts: any[]) {
      return stmts.map(() => ({ success: true, meta: { changes: 0 } }));
    },
    async dump() {
      return new ArrayBuffer(0);
    },
  };
}

// ==================== 测试 ====================

describe("数据库工厂 (D1 模式)", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.DB_DRIVER = "d1";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("传入 D1Database 时返回 Drizzle 实例", async () => {
    const { createDb } = await import("../database");
    const mockD1 = createMockD1();
    const db = await createDb(mockD1);

    expect(db).toBeDefined();
    expect(db.select).toBeDefined();
    expect(db.insert).toBeDefined();
    expect(db.update).toBeDefined();
    expect(db.delete).toBeDefined();
  });

  it("D1 模式下可以通过 schema 访问所有表", async () => {
    const { createDb } = await import("../database");
    const mockD1 = createMockD1();
    const db = await createDb(mockD1);

    // 验证 Drizzle 实例绑定了 schema
    expect(db._.fullSchema).toBeDefined();
    expect(db._.fullSchema.platforms).toBeDefined();
    expect(db._.fullSchema.apiKeys).toBeDefined();
    expect(db._.fullSchema.requestLogs).toBeDefined();
    expect(db._.fullSchema.auditLogs).toBeDefined();
  });

  it("D1 模式下 select 查询不抛异常", async () => {
    const { createDb } = await import("../database");
    const mockD1 = createMockD1();
    const db = await createDb(mockD1);

    // 这是 Drizzle 的查询构建，不会真正执行直到 await
    // 但构建过程本身不应该抛异常
    const query = db.select().from(sqliteSchema.platforms);
    expect(query).toBeDefined();
  });
});

describe("数据库工厂 (MySQL 模式)", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.DB_DRIVER = "mysql";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("没有 DATABASE_URL 时抛出错误", async () => {
    delete process.env.DATABASE_URL;
    const { createDb } = await import("../database");

    await expect(createDb()).rejects.toThrow("DATABASE_URL");
  });

  it("有 DATABASE_URL 时尝试连接（会因驱动未初始化而失败，但错误信息正确）", async () => {
    process.env.DATABASE_URL = "mysql://root:pass@localhost:3306/test";
    const { createDb } = await import("../database");

    // mysql2 驱动在测试环境中可能无法正常创建连接
    // 但应该抛出连接相关的错误，而不是 "DATABASE_URL 未配置"
    try {
      await createDb();
    } catch (err: any) {
      expect(err.message).not.toContain("DATABASE_URL");
    }
  });
});

describe("数据库工厂 (PG 模式)", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.DB_DRIVER = "pg";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("没有 DATABASE_URL 时抛出错误", async () => {
    delete process.env.DATABASE_URL;
    const { createDb } = await import("../database");

    await expect(createDb()).rejects.toThrow("DATABASE_URL");
  });
});

describe("数据库工厂 (默认模式)", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.DB_DRIVER;
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("未设置 DB_DRIVER 时默认使用 D1", async () => {
    const { createDb } = await import("../database");
    const mockD1 = createMockD1();

    // 默认应走 D1 分支
    const db = await createDb(mockD1);
    expect(db).toBeDefined();
  });

  it("没有 D1 binding 且非 Cloudflare 环境时抛出错误", async () => {
    const { createDb } = await import("../database");

    // 没有传入 d1，也没有 Cloudflare Context
    await expect(createDb()).rejects.toThrow("D1 数据库未配置");
  });
});

describe("Schema 导出", () => {
  it("database.ts 重新导出所有 schema 表", async () => {
    const db = await import("../database");

    // 验证 database.ts 通过 re-export 暴露了所有 schema
    expect(db.admins).toBeDefined();
    expect(db.platforms).toBeDefined();
    expect(db.proxyPools).toBeDefined();
    expect(db.proxies).toBeDefined();
    expect(db.plans).toBeDefined();
    expect(db.apiKeys).toBeDefined();
    expect(db.modelMappings).toBeDefined();
    expect(db.platformModels).toBeDefined();
    expect(db.requestLogs).toBeDefined();
    expect(db.dailyStats).toBeDefined();
    expect(db.configs).toBeDefined();
    expect(db.systemEvents).toBeDefined();
    expect(db.auditLogs).toBeDefined();
    expect(db.requestTemplates).toBeDefined();

    // snake_case 别名
    expect(db.audit_logs).toBeDefined();
    expect(db.request_logs).toBeDefined();
    expect(db.model_mappings).toBeDefined();
  });

  it("lib/db.ts 正确重新导出 createDb", async () => {
    const dbModule = await import("../db");
    expect(typeof dbModule.createDb).toBe("function");
  });
});

describe("re-export 链路", () => {
  it("src/lib/db.ts 重新导出 createDb", async () => {
    const srcDb = await import("../../src/lib/db");
    expect(typeof srcDb.createDb).toBe("function");
  });

  it("src/lib/schema.ts 重新导出所有表", async () => {
    const srcSchema = await import("../../src/lib/schema");
    expect(srcSchema.admins).toBeDefined();
    expect(srcSchema.platforms).toBeDefined();
    expect(srcSchema.apiKeys).toBeDefined();
    expect(srcSchema.requestLogs).toBeDefined();
  });
});
