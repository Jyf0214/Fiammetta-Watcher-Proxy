/**
 * PUT/DELETE /api/admin/platforms/[id] — 更新/删除平台
 */

import { type PagesFunction } from "@cloudflare/workers-types";

interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ENVIRONMENT?: string;
}

export const onRequestPut: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../../../lib/db").createDb> }).db;
  const { platforms } = await import("../../../../lib/schema");
  const { eq } = await import("drizzle-orm");
  const id = (context.params as { id: string }).id;

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

  const now = new Date().toISOString();
  await db.update(platforms).set({
    ...(name !== undefined && { name }),
    ...(baseUrl !== undefined && { baseUrl }),
    ...(apiKey !== undefined && { apiKey }),
    ...(apiKeys !== undefined && { apiKeys: JSON.stringify(apiKeys) }),
    ...(type !== undefined && { type }),
    ...(enabled !== undefined && { enabled }),
    ...(priority !== undefined && { priority }),
    ...(weight !== undefined && { weight }),
    ...(rpmLimit !== undefined && { rpmLimit }),
    ...(tpmLimit !== undefined && { tpmLimit }),
    ...(forwardHeaders !== undefined && { forwardHeaders: JSON.stringify(forwardHeaders) }),
    updatedAt: now,
  }).where(eq(platforms.id, id)).run();

  return Response.json({ success: true });
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../../../lib/db").createDb> }).db;
  const { platforms } = await import("../../../../lib/schema");
  const { eq } = await import("drizzle-orm");
  const id = (context.params as { id: string }).id;

  await db.delete(platforms).where(eq(platforms.id, id)).run();
  return Response.json({ success: true });
};
