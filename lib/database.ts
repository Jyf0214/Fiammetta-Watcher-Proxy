// ================================================================
// 统一数据库工厂 — 支持 D1 (SQLite) / MySQL / PostgreSQL
//
// 使用方式：
//   import { createDb } from "@/lib/database";
//   const db = await createDb();        // 自动检测
//   const db = await createDb(d1);      // 显式传入 D1 binding
//
// 切换数据库：设置环境变量 DB_DRIVER = "d1" | "mysql" | "pg"
//   - d1:  使用 Cloudflare D1（默认）
//   - mysql: 使用 DATABASE_URL 连接 MySQL
//   - pg:   使用 DATABASE_URL 连接 PostgreSQL
//
// 注意：MySQL 和 PostgreSQL 需要安装对应驱动
//   npm install mysql2   （MySQL）
//   npm install pg       （PostgreSQL）
// ================================================================

import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import * as sqliteSchema from "./schema";

// ==================== 类型导出 ====================

/** 所有数据库后端共用的类型（Drizzle 查询 API 一致） */
export type Database = ReturnType<typeof drizzleD1>;

/** D1Database 类型（Cloudflare 环境自带，此处声明以防非 CF 环境缺少） */
type D1DatabaseLike = Parameters<typeof drizzleD1>[0];

// ==================== 核心函数 ====================

/**
 * 创建数据库实例（异步）
 *
 * @param d1 - 可选，直接传入 D1Database binding（Worker 模式）
 *              未传时自动从 Cloudflare Context 或 DATABASE_URL 获取
 */
export async function createDb(d1?: D1DatabaseLike): Promise<Database> {
  const driver = (process.env.DB_DRIVER || "d1").toLowerCase();

  switch (driver) {
    case "mysql":
      return createMysqlDb();
    case "pg":
      return createPgDb();
    case "d1":
    default:
      return createD1Db(d1);
  }
}

// ==================== D1 (SQLite) ====================

async function createD1Db(d1?: D1DatabaseLike): Promise<Database> {
  // 1. 显式传入的 binding
  if (d1) {
    return drizzleD1(d1 as any, { schema: sqliteSchema });
  }

  // 2. 从 Cloudflare Context 自动获取
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const ctx = await getCloudflareContext({ async: true });
    const env = ctx.env as Record<string, unknown>;
    const binding = env.DB as D1DatabaseLike | undefined;
    if (binding) {
      return drizzleD1(binding as any, { schema: sqliteSchema });
    }
  } catch {
    // 非 Cloudflare 环境，继续尝试其他方式
  }

  // 3. 尝试从全局 env 获取（Worker 绑定）
  try {
    // @ts-expect-error Cloudflare Workers 全局 env
    const globalDb = globalThis.__DB__;
    if (globalDb) {
      return drizzleD1(globalDb, { schema: sqliteSchema });
    }
  } catch {
    // 忽略
  }

  throw new Error(
    "D1 数据库未配置：请传入 D1Database binding，或确保在 Cloudflare 环境中运行"
  );
}

// ==================== MySQL ====================

async function createMysqlDb(): Promise<Database> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("MySQL 模式需要 DATABASE_URL 环境变量（mysql://user:pass@host:port/db）");
  }

  // 动态导入，避免在 D1/PG 环境中打包 mysql2
  const mysql2 = await import("mysql2/promise");
  const pool = await mysql2.createPool(url);

  const { drizzle: drizzleMysql } = await import("drizzle-orm/mysql2");
  const mysqlSchema = require("./schema-mysql");
  return drizzleMysql(pool, { schema: mysqlSchema }) as unknown as Database;
}

// ==================== PostgreSQL ====================

async function createPgDb(): Promise<Database> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("PG 模式需要 DATABASE_URL 环境变量（postgresql://user:pass@host:port/db）");
  }

  // 动态导入，避免在 D1/MySQL 环境中打包 pg
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: url });

  const { drizzle: drizzlePg } = await import("drizzle-orm/node-postgres");
  const pgSchema = require("./schema-pg");
  return drizzlePg(pool, { schema: pgSchema }) as unknown as Database;
}

// ==================== Schema 再导出 ====================

// 所有消费者统一从 database.ts 导入 schema，无需关心底层数据库类型
export * from "./schema";
