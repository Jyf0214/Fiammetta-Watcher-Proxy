// ================================================================
// D1 连接工厂
// Worker 和 Pages Functions 共同使用
// ================================================================

import { drizzle } from "drizzle-orm/d1";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import * as schema from "./schema";

/**
 * 从 Cloudflare D1 binding 创建 Drizzle 实例
 *
 * 使用异步模式获取上下文，确保边缘运行时绑定已就绪
 * 调用方必须 await 此函数
 */
export async function createDb(db?: D1Database) {
  const d1 = db ?? ((await getCloudflareContext({ async: true })).env as Record<string, unknown>).DB as D1Database;
  if (!d1) {
    throw new Error("D1 数据库绑定未配置");
  }
  return drizzle(d1, { schema });
}

export type Database = ReturnType<typeof drizzle>;
