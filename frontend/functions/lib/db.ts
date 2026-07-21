/**
 * Drizzle ORM D1 客户端 — Pages Functions 专用
 */

import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export type Database = ReturnType<typeof createDb>;

export function createDb(db: D1Database) {
  return drizzle(db, { schema });
}
