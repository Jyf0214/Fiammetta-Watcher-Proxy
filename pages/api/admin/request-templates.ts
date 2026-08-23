/**
 * 请求模板 CRUD API
 *
 * 模板数据存储在 configs 表的 system:request_templates key 中，
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
import { getAdminFromRequest } from "@/lib/admin-auth";
import { checkCsrfOrigin } from "@/lib/admin-security";
import { checkAdminRateLimit } from "@/lib/admin-rate-limit";
import {
  CHAT_MERGEBODY_ALLOWED_KEYS,
  RESPONSES_MERGEBODY_ALLOWED_KEYS,
} from "@/lib/request-template-whitelist";
import { invalidateTemplatesCache } from "../../../worker/src/request-templates";

// Config 表中的存储键
const CONFIG_KEY = "system:request_templates";

/** 请求模板数据结构 */
export interface RequestTemplate {
  id: string;
  name: string;
  description: string;
  /** 适用的模型 ID 列表，支持通配符（如 "gpt-*"、"*"） */
  models: string[];
  mergeBody: Record<string, unknown>;
  enabled: boolean;
  /** 模板类型：chat=Chat Completions，responses=Responses API；缺省 chat 兼容旧数据 */
  type?: "chat" | "responses";
}

/** 校验 mergeBody 字段，按类型过滤不在白名单中的键；被丢弃的键收集进 droppedKeys 一并返回，供响应透出提示前端 */
function sanitizeMergeBody(
  body: Record<string, unknown>,
  type: "chat" | "responses" = "chat"
): { sanitized: Record<string, unknown>; droppedKeys: string[] } {
  const allowed = type === "responses" ? RESPONSES_MERGEBODY_ALLOWED_KEYS : CHAT_MERGEBODY_ALLOWED_KEYS;
  const sanitized: Record<string, unknown> = {};
  const droppedKeys: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (allowed.has(key)) {
      sanitized[key] = value;
    } else {
      droppedKeys.push(key);
    }
  }
  return { sanitized, droppedKeys };
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

/**
 * configs.updatedAt 为 Int 秒级列（毫秒写入会溢出），同一秒内连续两次保存会
 * 得到相同 updatedAt；运行时模板缓存失效基于 updatedAt 等值比较，同秒双保存
 * 会被判定为无变化、继续返回旧缓存（最长 30s 不生效）。
 * 进程内记录上次写入值，同秒时 +1 单调递增补偿（与 config.ts 的
 * nextConfigUpdatedAt 模式一致）。saveTemplates 是模板全部写操作的唯一入口
 * （POST/PUT/DELETE 均经此写入），无其他遗漏写入点。
 */
let lastTemplatesSaveAt = 0;

function nextTemplatesUpdatedAt(): number {
  const now = Math.floor(Date.now() / 1000);
  lastTemplatesSaveAt = Math.max(now, lastTemplatesSaveAt + 1);
  return lastTemplatesSaveAt;
}

/** 将模板列表写回 configs 表 */
async function saveTemplates(
  db: Awaited<ReturnType<typeof createDb>>,
  templates: RequestTemplate[]
): Promise<void> {
  const now = nextTemplatesUpdatedAt();
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
  invalidateTemplatesCache();
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    res.status(401).json({ success: false, error: "未授权" });
    return;
  }

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
      if (!checkCsrfOrigin(req, res)) return;
      if (!(await checkAdminRateLimit(admin.adminId, res))) return;
      const body: {
        name?: string;
        description?: string;
        models?: string[];
        mergeBody?: Record<string, unknown>;
        enabled?: boolean;
        type?: string;
      } = req.body;
      if (!body || typeof body !== "object") {
        res.status(400).json({ success: false, error: "请求格式错误" });
        return;
      }

      const { name, description, models, mergeBody, enabled, type } = body;

      // 参数校验
      if (!name || typeof name !== "string" || name.trim().length === 0) {
        res.status(400).json({ success: false, error: "模板名称不能为空" });
        return;
      }

      if (type !== undefined && type !== "chat" && type !== "responses") {
        res.status(400).json({ success: false, error: "模板类型必须为 chat 或 responses" });
        return;
      }
      const templateType: "chat" | "responses" = type === "responses" ? "responses" : "chat";

      // models 元素类型校验与 PUT 一致：非字符串元素会让运行时通配符匹配抛
      // TypeError 且被静默吞掉，导致全站请求模板失效
      if (!Array.isArray(models) || !models.every((m) => typeof m === "string")) {
        res.status(400).json({ success: false, error: "模型匹配列表必须为字符串数组" });
        return;
      }

      // mergeBody 校验与 PUT 分支同款：null/空/非对象/数组均 400（数组此前会
      // 被 sanitizeMergeBody 静默过滤为空对象，与 PUT 行为分叉）
      if (!mergeBody || typeof mergeBody !== "object" || Array.isArray(mergeBody)) {
        res.status(400).json({ success: false, error: "请求体内容不能为空" });
        return;
      }

      // description 类型校验与 PUT 一致：非字符串返回 400（此前静默置空
      // 会掩盖客户端传错类型的错误）
      if (description !== undefined && typeof description !== "string") {
        res.status(400).json({ success: false, error: "模板描述必须为字符串" });
        return;
      }

      // 读取现有模板
      const templates = await loadTemplates(db);

      // 白名单清洗：白名单外的键仍被丢弃（保持既有安全语义），但键名收集进
      // droppedKeys 随响应透出，避免"保存成功却静默丢字段"无任何提示
      const { sanitized: cleanMergeBody, droppedKeys } = sanitizeMergeBody(
        mergeBody as Record<string, unknown>,
        templateType
      );

      // 创建新模板
      const newTemplate: RequestTemplate = {
        id: crypto.randomUUID(),
        name: name.trim(),
        description: typeof description === "string" ? description.trim() : "",
        models: Array.isArray(models) && models.length > 0 ? models : ["*"],
        mergeBody: cleanMergeBody,
        // 创建时接受 enabled（表单开关），缺省保持默认启用
        enabled: enabled !== undefined ? Boolean(enabled) : true,
        type: templateType,
      };

      templates.push(newTemplate);
      await saveTemplates(db, templates);

      res.status(200).json({
        success: true,
        data: newTemplate,
        message: "模板创建成功",
        ...(droppedKeys.length > 0 ? { droppedKeys } : {}),
      });
      return;
    }

    // ==================== PUT — 更新已有模板 ====================
    if (req.method === "PUT") {
      if (!checkCsrfOrigin(req, res)) return;
      if (!(await checkAdminRateLimit(admin.adminId, res))) return;
      const body: {
        id?: string;
        name?: string;
        description?: string;
        models?: string[];
        mergeBody?: Record<string, unknown>;
        enabled?: boolean;
        type?: string;
      } = req.body;
      if (!body || typeof body !== "object") {
        res.status(400).json({ success: false, error: "请求格式错误" });
        return;
      }

      const { id, name, description, models, mergeBody, enabled, type } = body;

      // 校验必填字段
      if (!id) {
        res.status(400).json({ success: false, error: "缺少模板 ID" });
        return;
      }

      if (type !== undefined && type !== "chat" && type !== "responses") {
        res.status(400).json({ success: false, error: "模板类型必须为 chat 或 responses" });
        return;
      }

      // 读取现有模板
      const templates = await loadTemplates(db);
      const idx = templates.findIndex((t) => t.id === id);
      if (idx === -1) {
        res.status(404).json({ success: false, error: "模板不存在" });
        return;
      }

      // 白名单外被丢弃的键收集（mergeBody 重清洗 + 切换类型重清洗两条路径），
      // 响应透出给前端提示；Set 去重防止同键在两条路径中被计入两次
      const droppedKeys = new Set<string>();

      // 更新字段（仅更新传入的字段）；name/description 非字符串时
      // trim() 会抛 TypeError → 500，先做类型校验
      if (name !== undefined) {
        if (typeof name !== "string") {
          res.status(400).json({ success: false, error: "模板名称必须为字符串" });
          return;
        }
        templates[idx].name = name.trim();
      }
      if (description !== undefined) {
        if (typeof description !== "string") {
          res.status(400).json({ success: false, error: "模板描述必须为字符串" });
          return;
        }
        templates[idx].description = description.trim();
      }
      // models/enabled 与 name/description 同样做类型校验：非数组/非布尔
      // 直接赋值会把脏数据写入 configs，运行时通配符匹配/开关判断出错
      if (models !== undefined) {
        if (!Array.isArray(models) || !models.every((m) => typeof m === "string")) {
          res.status(400).json({ success: false, error: "模板模型列表必须为字符串数组" });
          return;
        }
        // 与 POST 同款归一化：清空即通配所有模型，避免落库空数组成为永不匹配的死模板
        templates[idx].models = models.length > 0 ? models : ["*"];
      }
      if (mergeBody !== undefined) {
        // 与 POST 分支同款校验：null/非对象/数组 → 400（合法对象才调用
        // sanitizeMergeBody；否则对 null 执行 Object.entries 抛 TypeError → 500）
        if (!mergeBody || typeof mergeBody !== "object" || Array.isArray(mergeBody)) {
          res.status(400).json({ success: false, error: "请求体内容不能为空" });
          return;
        }
        const effectiveType = type ?? templates[idx].type ?? "chat";
        const result = sanitizeMergeBody(mergeBody, effectiveType as "chat" | "responses");
        templates[idx].mergeBody = result.sanitized;
        for (const key of result.droppedKeys) droppedKeys.add(key);
      }
      if (enabled !== undefined) {
        if (typeof enabled !== "boolean") {
          res.status(400).json({ success: false, error: "模板启用状态必须为布尔值" });
          return;
        }
        templates[idx].enabled = enabled;
      }
      if (type !== undefined) {
        templates[idx].type = type as "chat" | "responses";
        // 切换类型后需按新白名单重新清洗已有 mergeBody，避免旧类型字段残留
        const result = sanitizeMergeBody(templates[idx].mergeBody, templates[idx].type as "chat" | "responses");
        templates[idx].mergeBody = result.sanitized;
        for (const key of result.droppedKeys) droppedKeys.add(key);
      }

      await saveTemplates(db, templates);

      res.status(200).json({
        success: true,
        data: templates[idx],
        message: "模板更新成功",
        ...(droppedKeys.size > 0 ? { droppedKeys: Array.from(droppedKeys) } : {}),
      });
      return;
    }

    // ==================== DELETE — 删除模板 ====================
    if (req.method === "DELETE") {
      if (!checkCsrfOrigin(req, res)) return;
      if (!(await checkAdminRateLimit(admin.adminId, res))) return;
      // 兼容两种传参：query（?id=xxx）与 body（{ id }），前端使用 query 方式
      const body: { id?: string } = req.body ?? {};
      const id = (req.query.id as string) || body.id;

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
    res.status(500).json({ success: false, error: "操作失败" });
  }
}
