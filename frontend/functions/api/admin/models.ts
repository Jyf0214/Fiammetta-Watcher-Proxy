/**
 * GET/POST /api/admin/models — 模型映射列表/创建
 */

import { type PagesFunction } from "@cloudflare/workers-types";

interface Env {
  DB: D1Database;
  ENVIRONMENT?: string;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../lib/db").createDb> }).db;
  const { modelMaps, platforms } = await import("../../lib/schema");
  const { eq } = await import("drizzle-orm");

  const rows = await db.select({
    id: modelMaps.id,
    alias: modelMaps.alias,
    targetModel: modelMaps.targetModel,
    platformId: modelMaps.platformId,
    platformName: platforms.name,
    createdAt: modelMaps.createdAt,
    updatedAt: modelMaps.updatedAt,
  }).from(modelMaps).leftJoin(platforms, eq(modelMaps.platformId, platforms.id)).all();

  return Response.json({ success: true, data: rows });
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../lib/db").createDb> }).db;
  const { modelMaps } = await import("../../lib/schema");

  let body: { alias?: string; targetModel?: string; platformId?: string };
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ success: false, error: "请求格式错误" }, { status: 400 });
  }

  if (!body.alias || !body.targetModel || !body.platformId) {
    return Response.json({ success: false, error: "alias、targetModel、platformId 为必填项" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.insert(modelMaps).values({
    id, alias: body.alias, targetModel: body.targetModel, platformId: body.platformId,
    createdAt: now, updatedAt: now,
  }).run();

  return Response.json({ success: true, data: { id } }, { status: 201 });
};
