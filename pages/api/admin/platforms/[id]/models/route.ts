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

import { NextRequest } from "next/server";
import { createDb } from "@/lib/db";
import { verifyToken } from "@/lib/auth";
import * as schema from "@/lib/schema";
import { eq, and } from "drizzle-orm";

declare const env: Record<string, any>;

/** 生成唯一 ID（cuid 风格） */
function generateId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * GET /api/admin/platforms/:id/models — 获取平台的模型列表
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return Response.json({ success: false, error: "未授权" }, { status: 401 });
  }

  try {
    const { id } = await params;
    const token = authHeader.slice(7);
    await verifyToken(token, (env as any).JWT_SECRET);

    const db = createDb((env as any).DB);
    const models = await db
      .select()
      .from(schema.platform_models)
      .where(eq(schema.platformModels.platformId, id));

    // 按 modelId 排序（SQLite 不支持在 select 中直接 orderBy 字段别名）
    models.sort((a, b) => a.modelId.localeCompare(b.modelId));

    return Response.json({ success: true, data: models });
  } catch (err) {
    console.error(
      "[GET /api/admin/platforms/[id]/models] 获取平台模型失败:",
      err
    );
    return Response.json(
      { success: false, error: "获取平台模型失败" },
      { status: 500 }
    );
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
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return Response.json({ success: false, error: "未授权" }, { status: 401 });
  }

  try {
    const { id } = await params;
    const token = authHeader.slice(7);
    await verifyToken(token, (env as any).JWT_SECRET);

    const body: any = await request.json();
    const { modelId, modelName, enabled } = body;

    if (
      !modelId ||
      typeof modelId !== "string" ||
      modelId.trim().length === 0
    ) {
      return Response.json(
        { success: false, error: "模型 ID 不能为空" },
        { status: 400 }
      );
    }

    const db = createDb((env as any).DB);

    // 检查平台是否存在
    const platformRows = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.id, id))
      .limit(1);

    if (platformRows.length === 0) {
      return Response.json(
        { success: false, error: "平台不存在" },
        { status: 404 }
      );
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
      return Response.json(
        { success: false, error: "该模型已存在" },
        { status: 400 }
      );
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

    return Response.json({
      success: true,
      data: inserted[0],
      message: "模型添加成功",
    });
  } catch (err) {
    console.error(
      "[POST /api/admin/platforms/[id]/models] 添加模型失败:",
      err
    );
    return Response.json(
      { success: false, error: "添加模型失败" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/admin/platforms/:id/models?modelId=xxx — 删除模型
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return Response.json({ success: false, error: "未授权" }, { status: 401 });
  }

  try {
    const { id } = await params;
    const token = authHeader.slice(7);
    await verifyToken(token, (env as any).JWT_SECRET);

    const { searchParams } = new URL(request.url);
    const modelId = searchParams.get("modelId");

    if (!modelId) {
      return Response.json(
        { success: false, error: "缺少 modelId 参数" },
        { status: 400 }
      );
    }

    const db = createDb((env as any).DB);

    // 删除匹配的记录
    await db
      .delete(schema.platform_models)
      .where(
        and(
          eq(schema.platformModels.platformId, id),
          eq(schema.platformModels.modelId, modelId)
        )
      );

    return Response.json({ success: true, message: "模型已删除" });
  } catch (err) {
    console.error(
      "[DELETE /api/admin/platforms/[id]/models] 删除模型失败:",
      err
    );
    return Response.json(
      { success: false, error: "删除模型失败" },
      { status: 500 }
    );
  }
}
