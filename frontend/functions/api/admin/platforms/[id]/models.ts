/**
 * GET/POST/DELETE /api/admin/platforms/[id]/models — 平台模型管理
 */

import { type PagesFunction } from "@cloudflare/workers-types";

interface Env {
  DB: D1Database;
  ENVIRONMENT?: string;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../../../../lib/db").createDb> }).db;
  const { platformModels } = await import("../../../../../lib/schema");
  const { eq } = await import("drizzle-orm");
  const platformId = (context.params as { id: string }).id;

  const rows = await db.select().from(platformModels).where(eq(platformModels.platformId, platformId)).all();
  return Response.json({ success: true, data: rows });
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../../../../lib/db").createDb> }).db;
  const { platformModels } = await import("../../../../../lib/schema");
  const platformId = (context.params as { id: string }).id;

  let body: { modelId?: string; ownedBy?: string; type?: string };
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ success: false, error: "请求格式错误" }, { status: 400 });
  }

  if (!body.modelId) {
    return Response.json({ success: false, error: "modelId 为必填项" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // 使用 OR IGNORE 防止重复插入（利用复合唯一约束）
  await db.run(
    (await import("drizzle-orm")).sql`INSERT OR IGNORE INTO platform_models (id, platform_id, model_id, owned_by, type, source, fetched_at) VALUES (${id}, ${platformId}, ${body.modelId}, ${body.ownedBy || null}, ${body.type || "chat"}, "manual", ${now})`
  );

  return Response.json({ success: true, data: { id } }, { status: 201 });
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../../../../lib/db").createDb> }).db;
  const { platformModels } = await import("../../../../../lib/schema");
  const { eq, and } = await import("drizzle-orm");
  const { id: platformId, modelId } = context.params as { id: string; modelId: string };

  await db.delete(platformModels).where(
    and(eq(platformModels.platformId, platformId), eq(platformModels.modelId, modelId))
  ).run();

  return Response.json({ success: true });
};
