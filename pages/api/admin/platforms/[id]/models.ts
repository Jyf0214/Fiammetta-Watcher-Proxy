/**
 * 平台模型管理 API
 *
 * GET  /api/admin/platforms/:id/models  — 获取平台的模型列表
 * POST /api/admin/platforms/:id/models  — 手动添加模型
 * DELETE /api/admin/platforms/:id/models?modelId=xxx — 删除模型
 *
 * 注意：远端自动刷新（PUT）和批量校正（PATCH）需要 fetchPlatformModels 和 detectModelType
 * 工具函数，待后续 Agent 实现后补充。
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/db";
import { verifyToken } from "@/lib/auth";
import * as schema from "@/lib/schema";
import { eq, and } from "drizzle-orm";


/** 生成唯一 ID（cuid 风格） */
function generateId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * GET /api/admin/platforms/:id/models — 获取平台的模型列表
 */
async function handleGet(req: NextApiRequest, res: NextApiResponse, id: string) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, error: "未授权" });
  }

  try {
    const token = authHeader.slice(7);
    await verifyToken(token, process.env.JWT_SECRET);

    const db = createDb((process.env as unknown as { DB: D1Database }).DB);
    const models = await db
      .select()
      .from(schema.platform_models)
      .where(eq(schema.platformModels.platformId, id));

    // 按 modelId 排序（SQLite 不支持在 select 中直接 orderBy 字段别名）
    models.sort((a, b) => a.modelId.localeCompare(b.modelId));

    return res.status(200).json({ success: true, data: models });
  } catch (err) {
    console.error(
      "[GET /api/admin/platforms/[id]/models] 获取平台模型失败:",
      err
    );
    return res.status(500).json({ success: false, error: "获取平台模型失败" });
  }
}

/**
 * POST /api/admin/platforms/:id/models — 手动添加模型
 *
 * body: { modelId: string, modelName?: string, enabled?: boolean }
 *
 * modelId  为模型在上游平台的唯一标识（如 gpt-4o）
 * modelName 为模型的显示名称，不传则默认与 modelId 相同
 */
async function handlePost(req: NextApiRequest, res: NextApiResponse, id: string) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, error: "未授权" });
  }

  try {
    const token = authHeader.slice(7);
    await verifyToken(token, process.env.JWT_SECRET);

    const body: any = req.body;
    const { modelId, modelName, enabled } = body;

    if (
      !modelId ||
      typeof modelId !== "string" ||
      modelId.trim().length === 0
    ) {
      return res.status(400).json({ success: false, error: "模型 ID 不能为空" });
    }

    const db = createDb((process.env as unknown as { DB: D1Database }).DB);

    // 检查平台是否存在
    const platformRows = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.id, id))
      .limit(1);

    if (platformRows.length === 0) {
      return res.status(404).json({ success: false, error: "平台不存在" });
    }

    // 检查是否已存在相同 modelId
    const existing = await db
      .select()
      .from(schema.platform_models)
      .where(
        and(
          eq(schema.platformModels.platformId, id),
          eq(schema.platformModels.modelId, modelId.trim())
        )
      )
      .limit(1);

    if (existing.length > 0) {
      return res.status(400).json({ success: false, error: "该模型已存在" });
    }

    const now = Math.floor(Date.now() / 1000);
    const newModelId = generateId();

    await db.insert(schema.platform_models).values({
      id: newModelId,
      platform_id: id,
      model_id: modelId.trim(),
      model_name: modelName?.trim() || modelId.trim(),
      enabled: enabled !== undefined ? (enabled ? 1 : 0) : 1,
      created_at: now,
    } as any);

    // 查询刚插入的记录返回
    const inserted = await db
      .select()
      .from(schema.platform_models)
      .where(eq(schema.platform_models.id, newModelId))
      .limit(1);

    return res.status(200).json({
      success: true,
      data: inserted[0],
      message: "模型添加成功",
    });
  } catch (err) {
    console.error(
      "[POST /api/admin/platforms/[id]/models] 添加模型失败:",
      err
    );
    return res.status(500).json({ success: false, error: "添加模型失败" });
  }
}

/**
 * DELETE /api/admin/platforms/:id/models?modelId=xxx — 删除模型
 */
async function handleDelete(req: NextApiRequest, res: NextApiResponse, id: string) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, error: "未授权" });
  }

  try {
    const token = authHeader.slice(7);
    await verifyToken(token, process.env.JWT_SECRET);

    const modelId = req.query.modelId as string | undefined;

    if (!modelId) {
      return res.status(400).json({ success: false, error: "缺少 modelId 参数" });
    }

    const db = createDb((process.env as unknown as { DB: D1Database }).DB);

    // 删除匹配的记录
    await db
      .delete(schema.platform_models)
      .where(
        and(
          eq(schema.platformModels.platformId, id),
          eq(schema.platformModels.modelId, modelId)
        )
      );

    return res.status(200).json({ success: true, message: "模型已删除" });
  } catch (err) {
    console.error(
      "[DELETE /api/admin/platforms/[id]/models] 删除模型失败:",
      err
    );
    return res.status(500).json({ success: false, error: "删除模型失败" });
  }
}

/**
 * 路由分发
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = String(req.query.id || "");

  switch (req.method) {
    case "GET":
      return handleGet(req, res, id);
    case "POST":
      return handlePost(req, res, id);
    case "DELETE":
      return handleDelete(req, res, id);
    default:
      res.setHeader("Allow", ["GET", "POST", "DELETE"]);
      return res.status(405).json({ success: false, error: "方法不允许" });
  }
}
