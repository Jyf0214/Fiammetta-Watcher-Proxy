/**
 * GET /api/admin/export — 数据导出
 *
 * 参数：type = "system" | "data" | "all"
 */

import { type PagesFunction } from "@cloudflare/workers-types";

interface Env { DB: D1Database; ENVIRONMENT?: string; }

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../lib/db").createDb> }).db;
  const url = new URL(context.request.url);
  const type = url.searchParams.get("type") || "all";

  const schema = await import("../../lib/schema");
  const result: Record<string, unknown> = {};

  if (type === "system" || type === "all") {
    result.platforms = await db.select().from(schema.platforms).all();
    result.modelMaps = await db.select().from(schema.modelMaps).all();
    result.plans = await db.select().from(schema.plans).all();
    result.configs = await db.select().from(schema.configs).all();
  }

  if (type === "data" || type === "all") {
    result.keys = await db.select().from(schema.apiKeys).all();
    result.proxies = await db.select().from(schema.proxies).all();
    result.proxyPools = await db.select().from(schema.proxyPools).all();
  }

  return Response.json({
    success: true,
    data: result,
    exportedAt: new Date().toISOString(),
    type,
  });
};
