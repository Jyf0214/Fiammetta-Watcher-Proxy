// ================================================================
// D1 连接工厂
// Worker 和 Pages Functions 共同使用
// ================================================================

import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

/**
 * 从 Cloudflare D1 binding 创建 Drizzle 实例
 *
 * @param db - D1 数据库 binding（通过 env.DB 传入）
 * @returns Drizzle ORM 数据库实例，自带 schema 类型推导
 *
 * @example
 * // Worker 中
 * export default {
 *   async fetch(request, env) {
 *     const db = createDb(env.DB);
 *     const platforms = await db.select().from(schema.platforms);
 *   }
 * }
 */
export function createDb(db: D1Database) {
  return drizzle(db, { schema });
}

export type Database = ReturnType<typeof createDb>;
