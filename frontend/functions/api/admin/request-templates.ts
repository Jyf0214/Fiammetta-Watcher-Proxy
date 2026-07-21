/**
 * GET/POST/DELETE /api/admin/request-templates — 请求模板管理
 */

import { type PagesFunction } from "@cloudflare/workers-types";

interface Env { DB: D1Database; KV: KVNamespace; ENVIRONMENT?: string; }

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../lib/db").createDb> }).db;
  const { configs } = await import("../../lib/schema");
  const { eq: eqFn } = await import("drizzle-orm");

  const config = await db.select().from(configs).where(eqFn(configs.key, "system:request_templates")).get();
  const templates = config?.value ? JSON.parse(config.value) : [];
  return Response.json({ success: true, data: templates });
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../lib/db").createDb> }).db;
  const env = (context.data as { env?: Env }).env;
  const { configs } = await import("../../lib/schema");
  const { eq: eqFn } = await import("drizzle-orm");

  let body: { id?: string; name: string; description: string; endpoint: string; mergeBody: Record<string, unknown>; enabled: boolean };
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ success: false, error: "请求格式错误" }, { status: 400 });
  }

  const config = await db.select().from(configs).where(eqFn(configs.key, "system:request_templates")).get();
  let templates = config?.value ? JSON.parse(config.value) : [];

  if (body.id) {
    // 更新
    templates = templates.map((t: Record<string, unknown>) => t.id === body.id ? { ...t, ...body } : t);
  } else {
    // 创建
    templates.push({ ...body, id: crypto.randomUUID() });
  }

  const now = new Date().toISOString();
  if (config) {
    await db.update(configs).set({ value: JSON.stringify(templates), updatedAt: now }).where(eqFn(configs.key, "system:request_templates")).run();
  } else {
    await db.insert(configs).values({ id: crypto.randomUUID(), key: "system:request_templates", value: JSON.stringify(templates), updatedAt: now }).run();
  }

  // 清除 KV 缓存
  if (env?.KV) {
    await env.KV.delete("tmpl_cache").catch(() => {});
  }

  return Response.json({ success: true });
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../lib/db").createDb> }).db;
  const env = (context.data as { env?: Env }).env;
  const { configs } = await import("../../lib/schema");
  const { eq: eqFn } = await import("drizzle-orm");

  let body: { id?: string };
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ success: false, error: "请求格式错误" }, { status: 400 });
  }

  const config = await db.select().from(configs).where(eqFn(configs.key, "system:request_templates")).get();
  if (!config) return Response.json({ success: true });

  let templates = JSON.parse(config.value);
  templates = templates.filter((t: Record<string, unknown>) => t.id !== body.id);

  const now = new Date().toISOString();
  await db.update(configs).set({ value: JSON.stringify(templates), updatedAt: now }).where(eqFn(configs.key, "system:request_templates")).run();

  if (env?.KV) {
    await env.KV.delete("tmpl_cache").catch(() => {});
  }

  return Response.json({ success: true });
};
