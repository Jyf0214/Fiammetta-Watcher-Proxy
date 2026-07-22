/**
 * 请求模板 CRUD API
 *
 * 模板数据存储在 D1 configs 表的 system:request_templates key 中，
 * 以 JSON 数组字符串的形式保存所有模板。
 *
 * 支持操作：
 * - GET    /api/admin/request-templates — 获取所有模板
 * - POST   /api/admin/request-templates — 创建新模板
 * - PUT    /api/admin/request-templates — 更新已有模板
 * - DELETE /api/admin/request-templates — 删除模板
 */


import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { createDb } from "@/lib/db";
import * as schema from "@/lib/schema";

// Config 表中的存储键
const CONFIG_KEY = "system:request_templates";

/** 请求模板数据结构 */
export interface RequestTemplate {
  id: string;
  name: string;
  description: string;
  endpoint: string; // "all" | "chat/completions" | "embeddings" | ...
  mergeBody: Record<string, unknown>;
  enabled: boolean;
}

/** 从请求上下文中获取 db 实例（中间件已注入） */
function getDb(context: { data?: Record<string, unknown> }) {
  const db = context.data?.db as ReturnType<typeof createDb> | undefined;
  if (!db) {
    throw new Error("数据库未初始化");
  }
  return db;
}

/** 从 context.data 读取所有模板 */
async function loadTemplates(
  db: ReturnType<typeof createDb>
): Promise<RequestTemplate[]> {
  const config = await db
    .select()
    .from(schema.configs)
    .where(eq(schema.configs.key, CONFIG_KEY))
    .get();
  return config?.value ? JSON.parse(config.value) : [];
}

/** 将模板列表写回 configs 表 */
async function saveTemplates(
  db: ReturnType<typeof createDb>,
  templates: RequestTemplate[]
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const existing = await db
    .select()
    .from(schema.configs)
    .where(eq(schema.configs.key, CONFIG_KEY))
    .get();

  if (existing) {
    await db
      .update(schema.configs)
      .set({ value: JSON.stringify(templates), updatedAt: now } as any)
      .where(eq(schema.configs.key, CONFIG_KEY))
      .run();
  } else {
    await db
      .insert(schema.configs)
      .values({
        id: crypto.randomUUID(),
        key: CONFIG_KEY,
        value: JSON.stringify(templates),
        updatedAt: now,
      } as any)
      .run();
  }
}

// ==================== GET — 获取所有模板 ====================

export async function GET(
  _request: NextRequest,
  context: { data?: Record<string, unknown> }
): Promise<Response> {
  try {
    const db = getDb(context);
    const templates = await loadTemplates(db);
    return Response.json({ success: true, data: templates });
  } catch (error) {
    console.error("[request-templates] GET 失败:", error);
    return Response.json(
      { success: false, error: "获取模板列表失败" },
      { status: 500 }
    );
  }
}

// ==================== POST — 创建新模板 ====================

export async function POST(
  request: NextRequest,
  context: { data?: Record<string, unknown> }
): Promise<Response> {
  try {
    const db = getDb(context);

    let body: {
      name?: string;
      description?: string;
      endpoint?: string;
      mergeBody?: Record<string, unknown>;
    };
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { success: false, error: "请求格式错误" },
        { status: 400 }
      );
    }

    const { name, description, endpoint, mergeBody } = body;

    // 参数校验
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return Response.json(
        { success: false, error: "模板名称不能为空" },
        { status: 400 }
      );
    }

    if (!mergeBody || typeof mergeBody !== "object") {
      return Response.json(
        { success: false, error: "请求体内容不能为空" },
        { status: 400 }
      );
    }

    // 读取现有模板
    const templates = await loadTemplates(db);

    // 创建新模板
    const newTemplate: RequestTemplate = {
      id: crypto.randomUUID(),
      name: name.trim(),
      description: description?.trim() || "",
      endpoint: endpoint || "all",
      mergeBody,
      enabled: true,
    };

    templates.push(newTemplate);
    await saveTemplates(db, templates);

    return Response.json({
      success: true,
      data: newTemplate,
      message: "模板创建成功",
    });
  } catch (error) {
    console.error("[request-templates] POST 失败:", error);
    return Response.json(
      { success: false, error: "创建模板失败" },
      { status: 500 }
    );
  }
}

// ==================== PUT — 更新已有模板 ====================

export async function PUT(
  request: NextRequest,
  context: { data?: Record<string, unknown> }
): Promise<Response> {
  try {
    const db = getDb(context);

    let body: {
      id?: string;
      name?: string;
      description?: string;
      endpoint?: string;
      mergeBody?: Record<string, unknown>;
      enabled?: boolean;
    };
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { success: false, error: "请求格式错误" },
        { status: 400 }
      );
    }

    const { id, name, description, endpoint, mergeBody, enabled } = body;

    // 校验必填字段
    if (!id) {
      return Response.json(
        { success: false, error: "缺少模板 ID" },
        { status: 400 }
      );
    }

    // 读取现有模板
    const templates = await loadTemplates(db);
    const idx = templates.findIndex((t) => t.id === id);
    if (idx === -1) {
      return Response.json(
        { success: false, error: "模板不存在" },
        { status: 404 }
      );
    }

    // 更新字段（仅更新传入的字段）
    if (name !== undefined) templates[idx].name = name.trim();
    if (description !== undefined) templates[idx].description = description.trim();
    if (endpoint !== undefined) templates[idx].endpoint = endpoint;
    if (mergeBody !== undefined) templates[idx].mergeBody = mergeBody;
    if (enabled !== undefined) templates[idx].enabled = enabled;

    await saveTemplates(db, templates);

    return Response.json({
      success: true,
      data: templates[idx],
      message: "模板更新成功",
    });
  } catch (error) {
    console.error("[request-templates] PUT 失败:", error);
    return Response.json(
      { success: false, error: "更新模板失败" },
      { status: 500 }
    );
  }
}

// ==================== DELETE — 删除模板 ====================

export async function DELETE(
  request: NextRequest,
  context: { data?: Record<string, unknown> }
): Promise<Response> {
  try {
    const db = getDb(context);

    let body: { id?: string };
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { success: false, error: "请求格式错误" },
        { status: 400 }
      );
    }

    const { id } = body;

    if (!id) {
      return Response.json(
        { success: false, error: "缺少模板 ID" },
        { status: 400 }
      );
    }

    // 读取现有模板
    const templates = await loadTemplates(db);
    const idx = templates.findIndex((t) => t.id === id);
    if (idx === -1) {
      return Response.json(
        { success: false, error: "模板不存在" },
        { status: 404 }
      );
    }

    // 删除指定模板
    templates.splice(idx, 1);
    await saveTemplates(db, templates);

    return Response.json({
      success: true,
      message: "模板已删除",
    });
  } catch (error) {
    console.error("[request-templates] DELETE 失败:", error);
    return Response.json(
      { success: false, error: "删除模板失败" },
      { status: 500 }
    );
  }
}
