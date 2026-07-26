// ================================================================
// Prisma 7 — 统一数据库工厂（Pages + Worker 共用）
//
// 本文件是整个项目中唯一知道 generated client 的文件。
// 所有业务代码只从此处导入 createDb / disconnectDb / 类型。
//
// 支持三种数据库方言（通过 DB_TYPE 环境变量选择）：
//   - d1：Cloudflare D1（SQLite 方言）
//   - tidb：TiDB Cloud（MySQL 方言）
//   - pg / hyperdrive：PostgreSQL（直连或 Hyperdrive 加速）
//
// 运行环境自动检测：
//   - Pages：通过 @opennextjs/cloudflare 获取 D1 binding
//   - Worker：通过 env 参数传入 binding
//
// 使用方式：
//   import { createDb } from "@/lib/prisma";
//   const prisma = await createDb();          // Pages（自动检测）
//   const prisma = await createDb(env);       // Worker（显式传入）
// ================================================================

/** 数据库类型 */
export type DbKind = "d1" | "tidb" | "pg" | "hyperdrive";

/** 全局 PrismaClient 实例缓存（Worker 生命周期内复用） */
let cachedPrisma: any = null;
let cachedDbKind: DbKind | null = null;

// ==================== 环境检测 ====================

/**
 * 根据 DB_TYPE 环境变量推断数据库类型
 * 无 DB_TYPE 时根据 DATABASE_URL 推断，默认 d1
 */
function resolveDbKind(env?: Record<string, unknown>): DbKind {
  // 优先读 DB_TYPE
  const dbType = (env?.DB_TYPE as string) || process.env.DB_TYPE;
  if (dbType === "tidb" || dbType === "mysql") return "tidb";
  if (dbType === "pg") return "pg";
  if (dbType === "hyperdrive") return "hyperdrive";
  if (dbType === "d1") return "d1";

  // 回退到 DATABASE_URL 推断（Pages 环境中 DATABASE_URL 在 env 对象中而非 process.env）
  const url = (env?.DATABASE_URL as string) || process.env.DATABASE_URL || "";
  if (url.startsWith("mysql://") || url.startsWith("mysqls://")) return "tidb";
  if (url.startsWith("postgresql://") || url.startsWith("postgres://")) return "pg";
  return "d1";
}

/**
 * 检测当前运行环境：Pages 还是 Worker
 *
 * 只要能从 @opennextjs/cloudflare 拿到 env 就认为是 Pages 环境，
 * 不再硬编码检查 env.DB（Hyperdrive 模式下没有 D1 binding）。
 */
async function detectEnvironment(): Promise<{ kind: "pages" | "worker"; pagesEnv?: Record<string, unknown> }> {
  // 尝试 Pages 环境（@opennextjs/cloudflare）
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const ctx = await getCloudflareContext({ async: true });
    const env = ctx.env as Record<string, unknown>;
    if (env && Object.keys(env).length > 0) {
      return { kind: "pages", pagesEnv: env };
    }
  } catch {
    // 非 Pages 环境
  }

  return { kind: "worker" };
}

// ==================== 动态 Client 加载 ====================

/**
 * 根据数据库类型动态加载对应的 PrismaClient 和 Adapter
 *
 * 这是整个项目中唯一直接 import generated client 的地方。
 * 三份 Schema 的表结构完全一致，导出的 PrismaClient API 也完全一致。
 */
async function createPrismaInstance(
  dbKind: DbKind,
  env?: Record<string, unknown>,
): Promise<any> {
  switch (dbKind) {
    // ── D1（SQLite 方言）──
    case "d1": {
      const { PrismaClient } = await import("../src/generated/d1/client");
      const { PrismaD1 } = await import("@prisma/adapter-d1");

      const d1Binding = env?.DB || (globalThis as any).__DB__;
      if (!d1Binding) throw new Error("D1 数据库未配置：未获取到 DB binding");

      const adapter = new PrismaD1(d1Binding as any);
      return new PrismaClient({ adapter });
    }

    // ── TiDB Cloud（MySQL 方言，HTTP 协议）──
    case "tidb": {
      const { PrismaClient } = await import("../src/generated/mysql/client");
      const { PrismaTiDBCloud } = await import("@tidbcloud/prisma-adapter");

      const url = (env?.TIDB_URL as string) || process.env.TIDB_URL || process.env.DATABASE_URL;
      if (!url) throw new Error("TIDB_URL 或 DATABASE_URL 未配置");

      const adapter = new PrismaTiDBCloud({ url });
      return new PrismaClient({ adapter });
    }

    // ── PostgreSQL 直连 ──
    case "pg": {
      const { PrismaClient } = await import("../src/generated/pg/client");
      const { PrismaPg } = await import("@prisma/adapter-pg");
      const { Pool } = await import("pg");

      const url = (env?.PG_URL as string) || process.env.PG_URL || process.env.DATABASE_URL;
      if (!url) throw new Error("PG_URL 或 DATABASE_URL 未配置");

      const pool = new Pool({ connectionString: url });
      const adapter = new PrismaPg(pool);
      return new PrismaClient({ adapter });
    }

    // ── PostgreSQL via Hyperdrive ──
    case "hyperdrive": {
      const { PrismaClient } = await import("../src/generated/pg/client");
      const { PrismaPg } = await import("@prisma/adapter-pg");
      const { PostgresJsPool } = await import("../lib/postgresjs-pool");

      const hyperdrive = env?.HYPERDRIVE as { connectionString: string } | undefined;
      if (!hyperdrive?.connectionString) {
        throw new Error("HYPERDRIVE binding 未配置（请检查 Cloudflare 绑定的名称是否叫 HYPERDRIVE）");
      }

      // 使用 postgres.js 而非 pg.Pool —— Cloudflare Hyperdrive 推荐的驱动
      // postgres.js 原生支持 transaction 模式，不会出现 pg.Pool 的连接复用问题
      const pool = new PostgresJsPool(hyperdrive.connectionString);
      const adapter = new PrismaPg(pool as any);
      return new PrismaClient({ adapter });
    }

    default:
      throw new Error(`未知的数据库类型: ${dbKind}`);
  }
}

// ==================== 公开 API ====================

/**
 * 获取 PrismaClient 实例（全局缓存，Worker 生命周期内复用）
 *
 * 支持两种调用方式：
 *   createDb()           — Pages 环境（自动检测 D1 binding）
 *   createDb(env)        — Worker 环境（传入完整 env 对象）
 *   createDb({ DB: d1 }) — 直接传入 D1Database binding（兼容旧代码）
 *
 * @returns any 类型的 PrismaClient（三个方言 API 完全一致）
 */
export async function createDb(
  env?: Record<string, unknown> | { DB: unknown }
): Promise<any> {
  // 兼容：如果直接传入了 D1Database binding（不是 env 对象）
  let resolvedEnv: Record<string, unknown> | undefined;
  if (env && typeof env === "object" && "DB" in env && typeof env.DB === "object" && env.DB !== null && !("DB_TYPE" in env)) {
    // 直接传入 D1Database：{ DB: d1Binding }
    resolvedEnv = { DB: env.DB };
  } else {
    resolvedEnv = env as Record<string, unknown> | undefined;
  }

  // Pages 无参调用时：从 Cloudflare 上下文获取完整 env（含 DB_TYPE、DATABASE_URL）
  let effectiveEnv = resolvedEnv;
  if (!effectiveEnv) {
    try {
      const detected = await detectEnvironment();
      if (detected.kind === "pages" && detected.pagesEnv) {
        effectiveEnv = detected.pagesEnv;
      }
    } catch {
      // 忽略
    }
  }

  const dbKind = resolveDbKind(effectiveEnv);

  // 命中缓存则直接复用
  if (cachedPrisma && cachedDbKind === dbKind) {
    return cachedPrisma;
  }

  // 创建新实例
  const prisma = await createPrismaInstance(dbKind, effectiveEnv);

  cachedPrisma = prisma;
  cachedDbKind = dbKind;

  return prisma;
}

/**
 * 断开 Prisma 连接（Worker 关闭时或需要重建实例时调用）
 */
export async function disconnectDb(): Promise<void> {
  if (cachedPrisma) {
    await cachedPrisma.$disconnect();
    cachedPrisma = null;
    cachedDbKind = null;
  }
}

// ==================== 类型导出 ====================
// 三份 Schema 的表结构完全一致，导出 D1 版本的类型作为通用类型。
// 业务代码通过 import type { Xxx } from "@/lib/prisma" 使用。

/** PrismaClient 类型（用于函数返回值类型标注） */
export type Database = any;

export type { Prisma } from "../src/generated/d1/client";
