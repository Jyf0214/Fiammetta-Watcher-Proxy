/**
 * GET/PUT /api/admin/config — 系统配置
 */

import { type PagesFunction } from "@cloudflare/workers-types";

interface Env { DB: D1Database; ENVIRONMENT?: string; }

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../../lib/db").createDb> }).db;
  const { configs } = await import("../../../lib/schema");

  const rows = await db.select().from(configs).all();
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return Response.json({ success: true, data: result });
};

export const onRequestPut: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../../lib/db").createDb> }).db;
  const { configs } = await import("../../../lib/schema");
  const { eq: eqFn } = await import("drizzle-orm");

  let body: Record<string, string>;
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ success: false, error: "请求格式错误" }, { status: 400 });
  }

  const now = new Date().toISOString();
  for (const [key, value] of Object.entries(body)) {
    const existing = await db.select().from(configs).where(eqFn(configs.key, key)).get();
    if (existing) {
      await db.update(configs).set({ value, updatedAt: now }).where(eqFn(configs.key, key)).run();
    } else {
      await db.insert(configs).values({ id: crypto.randomUUID(), key, value, updatedAt: now }).run();
    }
  }

  return Response.json({ success: true });
};
