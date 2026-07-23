/**
 * Worker 层 Prisma 数据库工厂
 *
 * Worker 环境不能使用全局单例 PrismaClient，
 * 每次请求/任务需创建独立实例，操作完成后 $disconnect()。
 */

import { PrismaClient } from "../../src/generated/client";
import { PrismaD1 } from "@prisma/adapter-d1";

/**
 * 创建 Prisma 客户端实例（绑定 D1）
 *
 * @param d1 - Cloudflare D1 数据库绑定
 * @returns 可直接使用的 PrismaClient 实例
 */
export function createPrismaClient(d1: D1Database): PrismaClient {
  const adapter = new PrismaD1(d1);
  return new PrismaClient({ adapter });
}
