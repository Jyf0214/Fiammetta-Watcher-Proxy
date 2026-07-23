/**
 * Worker 层 Prisma 数据库工厂
 *
 * Worker 环境不能使用全局单例 PrismaClient，
 * 每次请求/任务需创建独立实例，操作完成后 $disconnect()。
 *
 * 支持多种数据库后端：
 *   - D1Database binding（Cloudflare D1，推荐）
 *   - DATABASE_URL 环境变量（MySQL / PostgreSQL）
 */

import { PrismaClient } from "../../src/generated/client";
import { PrismaD1 } from "@prisma/adapter-d1";

/**
 * 创建 Prisma 客户端实例
 *
 * @param bindingOrUrl - D1Database binding 或数据库连接 URL
 * @returns 可直接使用的 PrismaClient 实例
 */
export async function createPrismaClient(bindingOrUrl: D1Database | string): Promise<PrismaClient> {
  // 字符串输入 → MySQL 或 PostgreSQL
  if (typeof bindingOrUrl === "string") {
    return createFromUrl(bindingOrUrl);
  }
  // D1Database 输入 → Cloudflare D1
  return createFromD1(bindingOrUrl);
}

/** 通过 D1 binding 创建 PrismaClient */
function createFromD1(d1: D1Database): PrismaClient {
  const adapter = new PrismaD1(d1);
  return new PrismaClient({ adapter });
}

/** 通过连接 URL 创建 PrismaClient（MySQL / PostgreSQL） */
async function createFromUrl(url: string): Promise<PrismaClient> {
  if (url.startsWith("mysql://") || url.startsWith("mysqls://")) {
    // @prisma/adapter-mariadb 兼容 MySQL（MariaDB 是 MySQL 的超集）
    const { PrismaMariaDb } = await import("@prisma/adapter-mariadb");
    const adapter = new PrismaMariaDb(url);
    return new PrismaClient({ adapter });
  }

  if (url.startsWith("postgresql://") || url.startsWith("postgres://")) {
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const adapter = new PrismaPg({ connectionString: url });
    return new PrismaClient({ adapter });
  }

  throw new Error(
    `不支持的数据库 URL 前缀：${url.slice(0, 10)}...，` +
    "仅支持 mysql:// 和 postgresql://"
  );
}
