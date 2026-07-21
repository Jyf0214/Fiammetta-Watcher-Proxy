/**
 * GET/POST /api/admin/platforms — 平台列表/创建
 */

import { type PagesFunction } from "@cloudflare/workers-types";

interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ENVIRONMENT?: string;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../../lib/db").createDb> }).db;
  const { platforms } = await import("../../../lib/schema");
  const { asc } = await import("drizzle-orm");

  const rows = await db.select().from(platforms).orderBy(asc(platforms.priority)).all();

  // 脱敏：不返回 apiKey 明文
  const safe = rows.map(({ apiKey, apiKeys, ...rest }) => ({
    ...rest,
    apiKey: apiKey ? `${apiKey.slice(0, 8)}...` : null,
    apiKeys: apiKeys ? JSON.parse(apiKeys).map((k: string) => `${k.slice(0, 8)}...`) : [],
  }));

  return Response.json({ success: true, data: safe });
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../../lib/db").createDb> }).db;
  const { platforms } = await import("../../../lib/schema");

  let body: Record<string, unknown>;
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ success: false, error: "请求格式错误" }, { status: 400 });
  }

  const { name, baseUrl, apiKey, apiKeys, type, enabled, priority, weight, rpmLimit, tpmLimit, forwardHeaders } = body as {
    name?: string; baseUrl?: string; apiKey?: string; apiKeys?: string[];
    type?: string; enabled?: boolean; priority?: number; weight?: number;
    rpmLimit?: number; tpmLimit?: number; forwardHeaders?: string[];
  };

  if (!name || !baseUrl || !apiKey) {
    return Response.json({ success: false, error: "name、baseUrl、apiKey 为必填项" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.insert(platforms).values({
    id, name, baseUrl, apiKey,
    apiKeys: JSON.stringify(apiKeys || []),
    type: type || "openai",
    enabled: enabled !== false,
    priority: priority || 0,
    weight: weight || 1,
    rpmLimit: rpmLimit || null,
    tpmLimit: tpmLimit || null,
    forwardHeaders: JSON.stringify(forwardHeaders || []),
    status: "healthy",
    createdAt: now,
    updatedAt: now,
  }).run();

  return Response.json({ success: true, data: { id } }, { status: 201 });
};
