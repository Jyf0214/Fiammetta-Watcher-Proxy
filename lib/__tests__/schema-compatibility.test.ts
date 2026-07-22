/**
 * Schema 兼容性测试
 *
 * 验证三套 schema 文件（SQLite / MySQL / PG）
 * 定义了完全相同的表名和列名。
 */

import { describe, it, expect } from "vitest";
import * as sqliteSchema from "../schema";
import * as mysqlSchema from "../schema-mysql";
import * as pgSchema from "../schema-pg";

// ==================== 表名对比 ====================

/** 从 schema 模块中提取所有表对象（排除 snake_case 别名） */
function getTableNames(schema: Record<string, any>): string[] {
  return Object.keys(schema).filter((key) => {
    const val = schema[key];
    return (
      val &&
      typeof val === "object" &&
      val._ &&
      typeof val._ === "object" &&
      val._.name
    );
  });
}

describe("Schema 表名一致性", () => {
  it("三套 schema 定义了完全相同的表名", () => {
    const sqliteTables = getTableNames(sqliteSchema);
    const mysqlTables = getTableNames(mysqlSchema);
    const pgTables = getTableNames(pgSchema);

    const sqliteSet = new Set(sqliteTables);
    const mysqlSet = new Set(mysqlTables);
    const pgSet = new Set(pgTables);

    for (const table of sqliteSet) {
      expect(mysqlSet.has(table), `MySQL 缺少表: ${table}`).toBe(true);
      expect(pgSet.has(table), `PG 缺少表: ${table}`).toBe(true);
    }
    for (const table of mysqlSet) {
      expect(sqliteSet.has(table), `SQLite 缺少表: ${table}`).toBe(true);
      expect(pgSet.has(table), `PG 缺少表: ${table}`).toBe(true);
    }
    for (const table of pgSet) {
      expect(sqliteSet.has(table), `SQLite 缺少表: ${table}`).toBe(true);
      expect(mysqlSet.has(table), `MySQL 缺少表: ${table}`).toBe(true);
    }
  });

  it("snake_case 别名也一致", () => {
    const aliases = Object.keys(sqliteSchema).filter(
      (key) =>
        key.includes("_") &&
        (sqliteSchema as any)[key] &&
        (sqliteSchema as any)[key]._
    );

    for (const alias of aliases) {
      expect((mysqlSchema as any)[alias], `MySQL 缺少别名: ${alias}`).toBeDefined();
      expect((pgSchema as any)[alias], `PG 缺少别名: ${alias}`).toBeDefined();
    }
  });
});

// ==================== 列名对比 ====================

describe("Schema 列名一致性", () => {
  const coreTables = [
    "admins",
    "platforms",
    "proxyPools",
    "proxies",
    "plans",
    "apiKeys",
    "modelMappings",
    "platformModels",
    "requestLogs",
    "dailyStats",
    "configs",
    "systemEvents",
    "auditLogs",
    "requestTemplates",
  ];

  for (const tableName of coreTables) {
    it(`${tableName} 表的列名在三套 schema 中一致`, () => {
      const sqliteTable = (sqliteSchema as any)[tableName];
      const mysqlTable = (mysqlSchema as any)[tableName];
      const pgTable = (pgSchema as any)[tableName];

      expect(sqliteTable).toBeDefined();
      expect(mysqlTable).toBeDefined();
      expect(pgTable).toBeDefined();

      // Drizzle table 对象：遍历自身属性找到列定义
      // 列定义的特征：有 name 属性且 name 是字符串
      const getColNames = (table: any) =>
        Object.keys(table).filter((key) => {
          const val = table[key];
          return (
            val &&
            typeof val === "object" &&
            typeof val.name === "string" &&
            val.name.length > 0
          );
        });

      const sqliteCols = getColNames(sqliteTable);
      const mysqlCols = getColNames(mysqlTable);
      const pgCols = getColNames(pgTable);

      expect(
        new Set(mysqlCols),
        `${tableName}: MySQL 列名与 SQLite 不一致`
      ).toEqual(new Set(sqliteCols));

      expect(
        new Set(pgCols),
        `${tableName}: PG 列名与 SQLite 不一致`
      ).toEqual(new Set(sqliteCols));
    });
  }
});
