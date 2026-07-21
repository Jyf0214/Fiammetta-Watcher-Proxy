/**
 * Drizzle ORM D1 客户端
 *
 * 创建 Drizzle 数据库实例，供所有路由和 lib 使用。
 * 每个请求通过 Hono 的 Context 传递 env.DB，确保正确的绑定。
 */

import { drizzle } from "drizzle-orm/d1";
import type { D1Database } from "@cloudflare/workers-types";
import * as schema from "./schema";

/**
 * 从 Cloudflare Env 创建 Drizzle 数据库实例
 */
export function createDb(db: D1Database) {
  return drizzle(db, { schema });
}

export type Database = ReturnType<typeof createDb>;
