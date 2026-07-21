/**
 * PUT/DELETE /api/admin/pools/[id] — 更新/删除代理池
 */

import { type PagesFunction } from "@cloudflare/workers-types";

interface Env { DB: D1Database; ENVIRONMENT?: string; }

export const onRequestPut: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../../../lib/db").createDb> }).db;
  const { proxyPools } = await import("../../../../lib/schema");
  const { eq } = await import("drizzle-orm");
  const id = (context.params as { id: string }).id;

  let body: { name?: string; enabled?: boolean };
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ success: false, error: "请求格式错误" }, { status: 400 });
  }

  const now = new Date().toISOString();
  await db.update(proxyPools).set({
    ...(body.name !== undefined && { name: body.name }),
    ...(body.enabled !== undefined && { enabled: body.enabled }),
    updatedAt: now,
  }).where(eq(proxyPools.id, id)).run();

  return Response.json({ success: true });
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../../../lib/db").createDb> }).db;
  const { proxyPools } = await import("../../../../lib/schema");
  const { eq } = await import("drizzle-orm");
  const id = (context.params as { id: string }).id;

  await db.delete(proxyPools).where(eq(proxyPools.id, id)).run();
  return Response.json({ success: true });
};
