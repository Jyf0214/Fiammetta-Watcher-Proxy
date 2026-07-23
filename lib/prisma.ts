// ================================================================
// Prisma 7 — PrismaClient 工厂（Pages Router 通用）
//
// 支持多种数据库后端（通过 DATABASE_URL 自动选择）：
//   - Cloudflare D1（无 DATABASE_URL，通过 CF Context 获取 binding）
//   - MySQL（DATABASE_URL=mysql://...）
//   - PostgreSQL（DATABASE_URL=postgresql://...）
//
// 使用方式：
//   import { createDb } from "@/lib/prisma";
//   const prisma = await createDb();
//   const rows = await prisma.platforms.findMany();
//
// 注意：
//   - Prisma 7 的 provider 是编译时常量，切换数据库后需 prisma generate
//   - runtime="cloudflare" 模式下必须通过 adapter 连接数据库
//   - 模块级缓存确保同一进程内复用 PrismaClient 实例
//   - Pages Router 不需要每次请求 $disconnect()
// ================================================================

import { PrismaClient } from "@/generated/client";

/** 全局 PrismaClient 实例（开发热更新时避免重复创建） */
const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

/** 数据库类型 */
type DbKind = "d1" | "mysql" | "postgresql";

/**
 * 根据 DATABASE_URL 推断数据库类型
 * 无 URL 时默认为 D1（Cloudflare Pages 环境）
 */
function resolveDbKind(): DbKind {
  const url = process.env.DATABASE_URL;
  if (!url) return "d1";
  if (url.startsWith("mysql://") || url.startsWith("mysqls://")) return "mysql";
  if (url.startsWith("postgresql://") || url.startsWith("postgres://")) return "postgresql";
  return "d1";
}

/**
 * 根据数据库类型动态加载对应的 Prisma 适配器
 */
async function loadAdapter(
  kind: DbKind,
  d1Binding?: unknown,
): Promise<{ adapter: unknown } | null> {
  switch (kind) {
    case "d1": {
      if (!d1Binding) {
        throw new Error("D1 数据库未配置：未获取到 D1 binding");
      }
      const { PrismaD1 } = await import("@prisma/adapter-d1");
      return { adapter: new PrismaD1(d1Binding as any) };
    }
    case "mysql": {
      const { PrismaMariaDb } = await import("@prisma/adapter-mariadb");
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error("DATABASE_URL 未配置");
      return { adapter: new PrismaMariaDb(url) };
    }
    case "postgresql": {
      // PostgreSQL 需要 @prisma/adapter-pg
      try {
        const pgAdapter = await import("@prisma/adapter-pg");
        const url = process.env.DATABASE_URL;
        if (!url) throw new Error("DATABASE_URL 未配置");
        return { adapter: new pgAdapter.PrismaPg({ connectionString: url }) };
      } catch (err: unknown) {
        if (err instanceof Error && "code" in err && (err as { code: string }).code === "ERR_MODULE_NOT_FOUND") {
          throw new Error(
            "PostgreSQL 支持需安装 @prisma/adapter-pg：npm install @prisma/adapter-pg",
            { cause: err },
          );
        }
        throw err;
      }
    }
  }
}

/**
 * 获取 PrismaClient 单例
 *
 * 自动根据 DATABASE_URL 选择数据库适配器：
 * - 无 URL → Cloudflare D1（从 CF Context 获取 binding）
 * - mysql:// → MySQL（Prisma 7 内建支持）
 * - postgresql:// → PostgreSQL（需 @prisma/adapter-pg）
 */
export async function createDb(): Promise<PrismaClient> {
  if (globalForPrisma.__prisma) {
    return globalForPrisma.__prisma;
  }

  const kind = resolveDbKind();
  let d1Binding: unknown = null;

  // D1 模式：从 Cloudflare Context 或全局变量获取 binding
  if (kind === "d1") {
    try {
      const { getCloudflareContext } = await import("@opennextjs/cloudflare");
      const ctx = await getCloudflareContext({ async: true });
      const env = ctx.env as Record<string, unknown>;
      d1Binding = env.DB;
    } catch {
      // 非 Cloudflare 环境，继续尝试其他方式
    }

    if (!d1Binding) {
      try {
        // @ts-expect-error Cloudflare Workers 全局 env
        d1Binding = globalThis.__DB__;
      } catch {
        // 忽略
      }
    }
  }

  const adapterResult = await loadAdapter(kind, d1Binding ?? undefined);

  const prismaOpts: ConstructorParameters<typeof PrismaClient>[0] = {
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  };

  if (adapterResult) {
    (prismaOpts as { adapter: unknown }).adapter = adapterResult.adapter;
  }

  const prisma = new PrismaClient(prismaOpts);
  globalForPrisma.__prisma = prisma;
  return prisma;
}

/**
 * 断开 Prisma 连接（Worker 模式下每次请求后调用）
 *
 * Pages Router 中通常不需要调用，除非内存压力大
 */
export async function disconnectDb(): Promise<void> {
  if (globalForPrisma.__prisma) {
    await globalForPrisma.__prisma.$disconnect();
    globalForPrisma.__prisma = undefined;
  }
}

export type Database = PrismaClient;
