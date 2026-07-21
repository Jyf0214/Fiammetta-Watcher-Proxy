/**
 * PUT/DELETE /api/admin/keys/[id] — 更新/删除 API Key
 */

import { type PagesFunction } from "@cloudflare/workers-types";

interface Env {
  DB: D1Database;
  ENVIRONMENT?: string;
}

export const onRequestPut: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../lib/db").createDb> }).db;
  const { apiKeys } = await import("../../lib/schema");
  const { eq } = await import("drizzle-orm");
  const id = (context.params as { id: string }).id;

  let body: Record<string, unknown>;
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ success: false, error: "请求格式错误" }, { status: 400 });
  }

  const { name, key, planId, quota, tokenLimit, callLimit, rpmLimit, tpmLimit, resetPeriod, status, expiresAt } = body as {
    name?: string; key?: string; planId?: string; quota?: number;
    tokenLimit?: number; callLimit?: number; rpmLimit?: number; tpmLimit?: number;
    resetPeriod?: string; status?: string; expiresAt?: string;
  };

  const now = new Date().toISOString();
  await db.update(apiKeys).set({
    ...(name !== undefined && { name }),
    ...(key !== undefined && { key }),
    ...(planId !== undefined && { planId }),
    ...(quota !== undefined && { quota }),
    ...(tokenLimit !== undefined && { tokenLimit }),
    ...(callLimit !== undefined && { callLimit }),
    ...(rpmLimit !== undefined && { rpmLimit }),
    ...(tpmLimit !== undefined && { tpmLimit }),
    ...(resetPeriod !== undefined && { resetPeriod }),
    ...(status !== undefined && { status }),
    ...(expiresAt !== undefined && { expiresAt }),
    updatedAt: now,
  }).where(eq(apiKeys.id, id)).run();

  return Response.json({ success: true });
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../lib/db").createDb> }).db;
  const { apiKeys } = await import("../../lib/schema");
  const { eq } = await import("drizzle-orm");
  const id = (context.params as { id: string }).id;

  await db.delete(apiKeys).where(eq(apiKeys.id, id)).run();
  return Response.json({ success: true });
};
