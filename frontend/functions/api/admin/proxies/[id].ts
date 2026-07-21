/**
 * PUT/DELETE /api/admin/proxies/[id] — 更新/删除代理
 */

import { type PagesFunction } from "@cloudflare/workers-types";

interface Env { DB: D1Database; ENVIRONMENT?: string; }

export const onRequestPut: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../lib/db").createDb> }).db;
  const { proxies } = await import("../../lib/schema");
  const { eq } = await import("drizzle-orm");
  const id = (context.params as { id: string }).id;

  let body: Record<string, unknown>;
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ success: false, error: "请求格式错误" }, { status: 400 });
  }

  const { address, poolId, enabled, status } = body as { address?: string; poolId?: string; enabled?: boolean; status?: string };
  const now = new Date().toISOString();
  await db.update(proxies).set({
    ...(address !== undefined && { address }),
    ...(poolId !== undefined && { poolId }),
    ...(enabled !== undefined && { enabled }),
    ...(status !== undefined && { status }),
    updatedAt: now,
  }).where(eq(proxies.id, id)).run();

  return Response.json({ success: true });
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../lib/db").createDb> }).db;
  const { proxies } = await import("../../lib/schema");
  const { eq } = await import("drizzle-orm");
  const id = (context.params as { id: string }).id;

  await db.delete(proxies).where(eq(proxies.id, id)).run();
  return Response.json({ success: true });
};
