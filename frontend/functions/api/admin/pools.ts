/**
 * GET/POST /api/admin/pools — 代理池列表/创建
 */

import { type PagesFunction } from "@cloudflare/next-on-pages";

interface Env { DB: D1Database; ENVIRONMENT?: string; }

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../../lib/db").createDb> }).db;
  const { proxyPools } = await import("../../../lib/schema");
  const rows = await db.select().from(proxyPools).all();
  return Response.json({ success: true, data: rows });
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../../lib/db").createDb> }).db;
  const { proxyPools } = await import("../../../lib/schema");

  let body: { name?: string; enabled?: boolean };
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ success: false, error: "请求格式错误" }, { status: 400 });
  }

  if (!body.name) {
    return Response.json({ success: false, error: "name 为必填项" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(proxyPools).values({ id, name: body.name, enabled: body.enabled !== false, createdAt: now, updatedAt: now }).run();
  return Response.json({ success: true, data: { id } }, { status: 201 });
};
