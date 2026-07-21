/**
 * PUT/DELETE /api/admin/models/[id] — 更新/删除模型映射
 */

import { type PagesFunction } from "@cloudflare/workers-types";

interface Env {
  DB: D1Database;
  ENVIRONMENT?: string;
}

export const onRequestPut: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../lib/db").createDb> }).db;
  const { modelMaps } = await import("../../lib/schema");
  const { eq } = await import("drizzle-orm");
  const id = (context.params as { id: string }).id;

  let body: { alias?: string; targetModel?: string; platformId?: string };
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ success: false, error: "请求格式错误" }, { status: 400 });
  }

  const now = new Date().toISOString();
  await db.update(modelMaps).set({
    ...(body.alias !== undefined && { alias: body.alias }),
    ...(body.targetModel !== undefined && { targetModel: body.targetModel }),
    ...(body.platformId !== undefined && { platformId: body.platformId }),
    updatedAt: now,
  }).where(eq(modelMaps.id, id)).run();

  return Response.json({ success: true });
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../lib/db").createDb> }).db;
  const { modelMaps } = await import("../../lib/schema");
  const { eq } = await import("drizzle-orm");
  const id = (context.params as { id: string }).id;

  await db.delete(modelMaps).where(eq(modelMaps.id, id)).run();
  return Response.json({ success: true });
};
