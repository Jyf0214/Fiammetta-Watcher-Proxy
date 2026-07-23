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

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";

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

/** 从 configs 表读取所有模板 */
async function loadTemplates(
  db: Awaited<ReturnType<typeof createDb>>
): Promise<RequestTemplate[]> {
  const config = await db.configs.findFirst({
    where: { key: CONFIG_KEY },
  });
  return config && config.value ? JSON.parse(config.value) : [];
}

/** 将模板列表写回 configs 表 */
async function saveTemplates(
  db: Awaited<ReturnType<typeof createDb>>,
  templates: RequestTemplate[]
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const existing = await db.configs.findFirst({
    where: { key: CONFIG_KEY },
  });

  if (existing) {
    await db.configs.update({
      where: { key: CONFIG_KEY },
      data: { value: JSON.stringify(templates), updatedAt: now },
    });
  } else {
    await db.configs.create({
      data: {
        id: crypto.randomUUID(),
        key: CONFIG_KEY,
        value: JSON.stringify(templates),
        updatedAt: now,
      },
    });
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    const db = await createDb();

    // ==================== GET — 获取所有模板 ====================
    if (req.method === "GET") {
      const templates = await loadTemplates(db);
      res.status(200).json({ success: true, data: templates });
      return;
    }

    // ==================== POST — 创建新模板 ====================
    if (req.method === "POST") {
      const body: {
        name?: string;
        description?: string;
        endpoint?: string;
        mergeBody?: Record<string, unknown>;
      } = req.body;
      if (!body || typeof body !== "object") {
        res.status(400).json({ success: false, error: "请求格式错误" });
        return;
      }

      const { name, description, endpoint, mergeBody } = body;

      // 参数校验
      if (!name || typeof name !== "string" || name.trim().length === 0) {
        res.status(400).json({ success: false, error: "模板名称不能为空" });
        return;
      }

      if (!mergeBody || typeof mergeBody !== "object") {
        res.status(400).json({ success: false, error: "请求体内容不能为空" });
        return;
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

      res.status(200).json({
        success: true,
        data: newTemplate,
        message: "模板创建成功",
      });
      return;
    }

    // ==================== PUT — 更新已有模板 ====================
    if (req.method === "PUT") {
      const body: {
        id?: string;
        name?: string;
        description?: string;
        endpoint?: string;
        mergeBody?: Record<string, unknown>;
        enabled?: boolean;
      } = req.body;
      if (!body || typeof body !== "object") {
        res.status(400).json({ success: false, error: "请求格式错误" });
        return;
      }

      const { id, name, description, endpoint, mergeBody, enabled } = body;

      // 校验必填字段
      if (!id) {
        res.status(400).json({ success: false, error: "缺少模板 ID" });
        return;
      }

      // 读取现有模板
      const templates = await loadTemplates(db);
      const idx = templates.findIndex((t) => t.id === id);
      if (idx === -1) {
        res.status(404).json({ success: false, error: "模板不存在" });
        return;
      }

      // 更新字段（仅更新传入的字段）
      if (name !== undefined) templates[idx].name = name.trim();
      if (description !== undefined) templates[idx].description = description.trim();
      if (endpoint !== undefined) templates[idx].endpoint = endpoint;
      if (mergeBody !== undefined) templates[idx].mergeBody = mergeBody;
      if (enabled !== undefined) templates[idx].enabled = enabled;

      await saveTemplates(db, templates);

      res.status(200).json({
        success: true,
        data: templates[idx],
        message: "模板更新成功",
      });
      return;
    }

    // ==================== DELETE — 删除模板 ====================
    if (req.method === "DELETE") {
      const body: { id?: string } = req.body;
      if (!body || typeof body !== "object") {
        res.status(400).json({ success: false, error: "请求格式错误" });
        return;
      }

      const { id } = body;

      if (!id) {
        res.status(400).json({ success: false, error: "缺少模板 ID" });
        return;
      }

      // 读取现有模板
      const templates = await loadTemplates(db);
      const idx = templates.findIndex((t) => t.id === id);
      if (idx === -1) {
        res.status(404).json({ success: false, error: "模板不存在" });
        return;
      }

      // 删除指定模板
      templates.splice(idx, 1);
      await saveTemplates(db, templates);

      res.status(200).json({
        success: true,
        message: "模板已删除",
      });
      return;
    }

    // 不支持的 HTTP 方法
    res.setHeader("Allow", ["GET", "POST", "PUT", "DELETE"]);
    res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (error) {
    console.error("[request-templates] 操作失败:", error);
    res.status(500).json({ success: false, error: "操作失败", detail: error instanceof Error ? error.message : String(error) });
  }
}
