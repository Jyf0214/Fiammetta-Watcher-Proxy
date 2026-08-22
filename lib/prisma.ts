// ================================================================
// Prisma 7 — 统一数据库工厂（Pages + Worker 共用）
//
// 本文件是整个项目中唯一知道 generated client 的文件。
// 所有业务代码只从此处导入 createDb / disconnectDb / 类型。
//
// 支持多种数据库方言（通过 DB_TYPE 环境变量选择）：
//   - d1：Cloudflare D1（SQLite 方言）
//   - tidb：TiDB Cloud（MySQL 方言，HTTP 协议）
//   - mysql：纯 MySQL（mariadb 驱动，TCP；仅非 Cloudflare 平台）
//   - mariadb：MariaDB（mariadb 驱动，TCP；仅非 Cloudflare 平台）
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
export type DbKind = "d1" | "tidb" | "mysql" | "mariadb" | "pg" | "hyperdrive";

/** 全局 PrismaClient 实例缓存（Worker 生命周期内复用） */
let cachedPrisma: any = null;
let cachedDbKind: DbKind | null = null;
let cachedBindingKey: string | null = null;

// ==================== 环境检测 ====================

/**
 * 根据 DB_TYPE 环境变量推断数据库类型
 * 无 DB_TYPE 时根据 DATABASE_URL 推断，默认 d1（开发环境通过 .env.local
 * 写入 DB_TYPE=pg + DATABASE_URL 切换到本地嵌入式 PostgreSQL）
 */
function resolveDbKind(env?: Record<string, unknown>): DbKind {
  // 优先读 DB_TYPE
  const dbType = (env?.DB_TYPE as string) || process.env.DB_TYPE;
  if (dbType === "tidb") return "tidb";
  if (dbType === "mysql") return "mysql";
  if (dbType === "mariadb") return "mariadb";
  if (dbType === "pg") return "pg";
  if (dbType === "hyperdrive") return "hyperdrive";
  if (dbType === "d1") return "d1";

  // 回退到 DATABASE_URL 推断（Pages 环境中 DATABASE_URL 在 env 对象中而非 process.env）
  const url = (env?.DATABASE_URL as string) || process.env.DATABASE_URL || "";
  // mysqls:// 是 TiDB Cloud 的 TLS 连接串格式，仍按 tidb（HTTP 适配器）处理；
  // mariadb 驱动不识别 mysqls:// scheme，纯 MySQL 用 mysql://
  if (url.startsWith("mysqls://")) return "tidb";
  if (url.startsWith("mysql://")) return "mysql";
  if (url.startsWith("mariadb://")) return "mariadb";
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

    // ── MariaDB（mariadb 驱动，TCP；仅非 Cloudflare 平台）──
    case "mariadb": {
      const { PrismaClient } = await import("../src/generated/mariadb/client");
      const { PrismaMariaDb } = await import("@prisma/adapter-mariadb");

      const url = (env?.MARIADB_URL as string) || process.env.MARIADB_URL || process.env.DATABASE_URL;
      if (!url) throw new Error("MARIADB_URL 或 DATABASE_URL 未配置");

      const adapter = new PrismaMariaDb(url);
      return new PrismaClient({ adapter });
    }

    // ── 纯 MySQL（mariadb 驱动，TCP；仅非 Cloudflare 平台）──
    case "mysql": {
      const { PrismaClient } = await import("../src/generated/mysql/client");
      const { PrismaMariaDb } = await import("@prisma/adapter-mariadb");

      const url = (env?.MYSQL_URL as string) || process.env.MYSQL_URL || process.env.DATABASE_URL;
      if (!url) throw new Error("MYSQL_URL 或 DATABASE_URL 未配置");

      const adapter = new PrismaMariaDb(url);
      return new PrismaClient({ adapter });
    }

    // ── PostgreSQL 直连 ──
    case "pg": {
      const { PrismaClient } = await import("../src/generated/pg/client");
      const { PrismaPg } = await import("@prisma/adapter-pg");
      const { Pool } = await import("pg");

      const url = (env?.PG_URL as string) || process.env.PG_URL || process.env.DATABASE_URL;
      if (!url) throw new Error("PG_URL 或 DATABASE_URL 未配置");

      const pool = new Pool({
        connectionString: url,
        // 256MB 容器下限制连接数，每连接约 2-4MB buffer
        max: 3,
        // 空闲连接 30 秒后自动关闭回收内存
        idleTimeoutMillis: 30_000,
        // 连接建立超时
        connectionTimeoutMillis: 10_000,
      });
      // pg 官方要求：空闲连接错误（数据库重启/网络闪断）必须显式消费，
      // 否则 Node 视为未捕获 error 事件直接崩溃进程
      pool.on("error", (err) => {
        console.error("[prisma] PostgreSQL 连接池错误（空闲连接断开）:", err.message);
      });
      // pool 由本工厂创建，$disconnect 时应一并释放（默认不释放外部传入的 pool）
      const adapter = new PrismaPg(pool, { disposeExternalPool: true });
      return new PrismaClient({ adapter });
    }

    // ── PostgreSQL via Hyperdrive ──
    case "hyperdrive": {
      const { PrismaClient } = await import("../src/generated/pg/client");
      const { PrismaPg } = await import("@prisma/adapter-pg");
      const { Pool } = await import("pg");

      const hyperdrive = env?.HYPERDRIVE as { connectionString: string } | undefined;
      // 兼容入口同步到 process.env 的场景（业务模块只把 { DB, DB_TYPE } 传给 createDb，
      // Worker/Pages 入口会把完整 env（含 HYPERDRIVE binding）写入 process.env）
      let resolved = hyperdrive;
      if (!resolved?.connectionString && process.env.HYPERDRIVE) {
        try {
          resolved = JSON.parse(process.env.HYPERDRIVE);
        } catch {
          // 忽略损坏的 JSON，走下方报错
        }
      }
      if (!resolved?.connectionString) {
        throw new Error("HYPERDRIVE binding 未配置（请检查 Cloudflare 绑定的名称是否叫 HYPERDRIVE）");
      }

      const pool = new Pool({ connectionString: resolved.connectionString, max: 1 });
      // 同直连分支：空闲连接错误必须显式消费，否则进程崩溃
      pool.on("error", (err) => {
        console.error("[prisma] Hyperdrive 连接池错误（空闲连接断开）:", err.message);
      });
      const adapter = new PrismaPg(pool, { disposeExternalPool: true });
      return new PrismaClient({ adapter });
    }

    default:
      throw new Error(`未知的数据库类型: ${dbKind}`);
  }
}

// ==================== 公开 API ====================

/**
 * 解析有效环境变量对象
 * - 直接传入 { DB } 视为 D1 binding（兼容旧代码）
 * - 无参调用时从 Cloudflare 上下文获取完整 env（含 DB_TYPE、DATABASE_URL）
 */
async function resolveEffectiveEnv(
  env?: Record<string, unknown> | { DB: unknown }
): Promise<Record<string, unknown> | undefined> {
  // 兼容：如果直接传入了 D1Database binding（不是 env 对象）
  if (env && typeof env === "object" && "DB" in env && typeof env.DB === "object" && env.DB !== null && !("DB_TYPE" in env)) {
    return { DB: env.DB };
  }

  const resolvedEnv = env as Record<string, unknown> | undefined;
  if (resolvedEnv) return resolvedEnv;

  // Pages 无参调用时：从 Cloudflare 上下文获取完整 env（含 DB_TYPE、DATABASE_URL）
  try {
    const detected = await detectEnvironment();
    if (detected.kind === "pages" && detected.pagesEnv) {
      return detected.pagesEnv;
    }
  } catch {
    // 忽略
  }
  return undefined;
}

/**
 * 获取当前数据库类型（与 createDb 使用完全相同的解析逻辑）
 *
 * @returns d1 / tidb / mysql / mariadb / pg / hyperdrive
 */
export async function getDbKind(
  env?: Record<string, unknown> | { DB: unknown }
): Promise<DbKind> {
  const effectiveEnv = await resolveEffectiveEnv(env);
  return resolveDbKind(effectiveEnv);
}

/**
 * 获取 PrismaClient 实例（全局缓存，Worker 生命周期内复用）
 *
 * 支持两种调用方式：
 *   createDb()           — Pages 环境（自动检测 D1 binding）
 *   createDb(env)        — Worker 环境（传入完整 env 对象）
 *   createDb({ DB: d1 }) — 直接传入 D1Database binding（兼容旧代码）
 *
 * @returns 类型化的 PrismaClient（三个方言 API 完全一致）
 */
function getBindingKey(env: Record<string, unknown> | undefined, dbKind: DbKind): string {
  if (!env) return "no-env";
  if (dbKind === "d1") {
    const b = (env as any).DB;
    return b ? `d1:${String((b as any).__bindingId ?? (b as any).id ?? b)}` : "d1:no-binding";
  }
  if (dbKind === "hyperdrive") {
    const hd = (env as any).HYPERDRIVE as { connectionString?: string } | undefined;
    const cs = hd?.connectionString ?? (process.env.HYPERDRIVE ? (()=>{ try{ return JSON.parse(process.env.HYPERDRIVE!).connectionString }catch{return ""}})() : "");
    return `hyperdrive:${cs ?? ""}`;
  }
  if (dbKind === "pg") {
    const url = (env as any).PG_URL ?? (env as any).DATABASE_URL ?? process.env.PG_URL ?? process.env.DATABASE_URL ?? "";
    return `pg:${url}`;
  }
  if (dbKind === "tidb") {
    const url = (env as any).TIDB_URL ?? (env as any).DATABASE_URL ?? process.env.TIDB_URL ?? process.env.DATABASE_URL ?? "";
    return `tidb:${url}`;
  }
  if (dbKind === "mariadb") {
    const url = (env as any).MARIADB_URL ?? (env as any).DATABASE_URL ?? process.env.MARIADB_URL ?? process.env.DATABASE_URL ?? "";
    return `mariadb:${url}`;
  }
  if (dbKind === "mysql") {
    const url = (env as any).MYSQL_URL ?? (env as any).DATABASE_URL ?? process.env.MYSQL_URL ?? process.env.DATABASE_URL ?? "";
    return `mysql:${url}`;
  }
  return `${dbKind}:unknown`;
}

export async function createDb(
  env?: Record<string, unknown> | { DB: unknown }
): Promise<Database> {
  const effectiveEnv = await resolveEffectiveEnv(env);
  const dbKind = resolveDbKind(effectiveEnv);
  const bindingKey = getBindingKey(effectiveEnv as Record<string, unknown> | undefined, dbKind);

  // 命中缓存则直接复用（需同时校验 DbKind 与绑定身份，避免同一进程内不同 DB 实例复用错误连接）
  if (cachedPrisma && cachedDbKind === dbKind && cachedBindingKey === bindingKey) {
    return cachedPrisma;
  }

  // 绑定或类型变化时若已有缓存，先优雅断开旧连接（避免 pg Pool 泄漏）
  if (cachedPrisma && (cachedDbKind !== dbKind || cachedBindingKey !== bindingKey)) {
    try { await cachedPrisma.$disconnect(); } catch {}
    cachedPrisma = null;
    cachedDbKind = null;
    cachedBindingKey = null;
  }

  // 创建新实例
  const prisma = await createPrismaInstance(dbKind, effectiveEnv);

  cachedPrisma = prisma;
  cachedDbKind = dbKind;
  cachedBindingKey = bindingKey;

  return prisma;
}

/**
 * 断开 Prisma 连接（Worker 关闭时或需要重建实例时调用）
 *
 * 仅测试使用，生产路径不调用（全局连接缓存设计）
 */
export async function disconnectDb(): Promise<void> {
  if (cachedPrisma) {
    await cachedPrisma.$disconnect();
    cachedPrisma = null;
    cachedDbKind = null;
    cachedBindingKey = null;
  }
}

// ==================== 类型导出 ====================
// 三份 Schema 的表结构完全一致，导出 D1 版本的类型作为通用类型。
// 业务代码通过 import type { Xxx } from "@/lib/prisma" 使用。

import type { PrismaClient } from "../src/generated/d1/client";

/** PrismaClient 类型（用于函数返回值类型标注） */
export type Database = PrismaClient;

export type { Prisma } from "../src/generated/d1/client";
