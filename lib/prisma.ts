// ================================================================
// Prisma 7 — PrismaClient 工厂（Pages Router + Worker 通用）
//
// 使用方式：
//   import { createDb } from "@/lib/prisma";
//   const prisma = await createDb();
//   const rows = await prisma.platforms.findMany();
//
// 注意：
//   - Prisma 7 在 Pages Router 中自动从 Cloudflare Context 获取 D1 binding
//   - 模块级缓存确保同一进程内复用 PrismaClient 实例
//   - Pages Router 不需要每次请求 $disconnect()
// ================================================================

import { PrismaClient } from "@/generated/client";

/** 全局 PrismaClient 实例（开发热更新时避免重复创建） */
const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

/**
 * 获取 PrismaClient 单例
 *
 * 自动从 Cloudflare Context 获取 D1 binding 并初始化 PrismaD1 adapter。
 * 模块级缓存确保同一进程内复用 PrismaClient 实例。
 *
 * @returns PrismaClient 实例
 */
export async function createDb(): Promise<PrismaClient> {
  if (globalForPrisma.__prisma) {
    return globalForPrisma.__prisma;
  }

  // 动态导入 PrismaD1 adapter
  const { PrismaD1 } = await import("@prisma/adapter-d1");

  // 从 Cloudflare Context 获取 D1 binding
  let d1Binding: unknown = null;

  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const ctx = await getCloudflareContext({ async: true });
    const env = ctx.env as Record<string, unknown>;
    d1Binding = env.DB;
  } catch {
    // 非 Cloudflare 环境，继续尝试其他方式
  }

  // 尝试从全局 env 获取（Worker 绑定）
  if (!d1Binding) {
    try {
      // @ts-expect-error Cloudflare Workers 全局 env
      d1Binding = globalThis.__DB__;
    } catch {
      // 忽略
    }
  }

  if (!d1Binding) {
    throw new Error(
      "D1 数据库未配置：请确保在 Cloudflare 环境中运行，或传入 D1Database binding"
    );
  }

  const adapter = new PrismaD1(d1Binding as any);
  const prisma = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

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
