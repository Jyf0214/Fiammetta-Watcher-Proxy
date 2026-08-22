/**
 * 接口映射 CRUD API
 *
 * 将下游模型通配符映射到上游目标模型的 API 结构转换规则
 * 存储在 configs 表的 system:api_mappings key 中
 *
 * 支持：
 * - GET    /api/admin/api-mappings — 获取所有映射
 * - POST   /api/admin/api-mappings — 创建
 * - PUT    /api/admin/api-mappings — 更新
 * - DELETE /api/admin/api-mappings — 删除
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/admin-auth";
import { checkCsrfOrigin } from "@/lib/admin-security";
import { checkAdminRateLimit } from "@/lib/admin-rate-limit";
import { invalidateApiMappingsCache } from "../../../worker/src/api-mappings";
import { invalidateRouterCache } from "../../../worker/src/router";

const CONFIG_KEY = "system:api_mappings";

export interface ApiMapping {
  id: string;
  name: string;
  description: string;
  pattern: string;
  targetModel: string;
  sourceApi: "chat" | "responses";
  targetApi: "chat" | "responses";
  platformId?: string | null;
  enabled: boolean;
}

function isValidPattern(p: string): boolean {
  return typeof p === "string" && p.length > 0 && p.length <= 200 && /^[a-zA-Z0-9._\-/*]+$/.test(p);
}

async function loadMappings(db: Awaited<ReturnType<typeof createDb>>): Promise<ApiMapping[]> {
  const row = await db.configs.findFirst({ where: { key: CONFIG_KEY } });
  return row && row.value ? JSON.parse(row.value) : [];
}

let lastSaveAt = 0;
function nextUpdatedAt(): number {
  const now = Math.floor(Date.now() / 1000);
  lastSaveAt = Math.max(now, lastSaveAt + 1);
  return lastSaveAt;
}

async function saveMappings(db: Awaited<ReturnType<typeof createDb>>, list: ApiMapping[]): Promise<void> {
  const now = nextUpdatedAt();
  const existing = await db.configs.findFirst({ where: { key: CONFIG_KEY } });
  if (existing) {
    await db.configs.update({ where: { key: CONFIG_KEY }, data: { value: JSON.stringify(list), updatedAt: now } });
  } else {
    await db.configs.create({ data: { id: crypto.randomUUID(), key: CONFIG_KEY, value: JSON.stringify(list), updatedAt: now } });
  }
  invalidateApiMappingsCache();
  invalidateRouterCache();
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    res.status(401).json({ success: false, error: "未授权" });
    return;
  }

  try {
    const db = await createDb();

    if (req.method === "GET") {
      const list = await loadMappings(db);
      res.status(200).json({ success: true, data: list });
      return;
    }

    if (req.method === "POST") {
      if (!checkCsrfOrigin(req, res)) return;
      if (!(await checkAdminRateLimit(admin.adminId, res))) return;
      const body: any = req.body;
      if (!body || typeof body !== "object") {
        res.status(400).json({ success: false, error: "请求格式错误" });
        return;
      }
      const { name, description, pattern, targetModel, sourceApi, targetApi, platformId, enabled } = body;
      if (!name || typeof name !== "string" || !name.trim()) {
        res.status(400).json({ success: false, error: "名称不能为空" });
        return;
      }
      if (!pattern || !isValidPattern(pattern)) {
        res.status(400).json({ success: false, error: "模型匹配模式不合法（支持 * 通配，限 200 字符）" });
        return;
      }
      // targetModel 允许空（表示与下游同模，保持原模型名）；“*” 亦表示同模
      if (targetModel !== undefined && targetModel !== null && typeof targetModel !== "string") {
        res.status(400).json({ success: false, error: "目标模型必须为字符串" });
        return;
      }
      const normalizedTargetModel = typeof targetModel === "string" ? targetModel.trim() : "";
      if (sourceApi !== "chat" && sourceApi !== "responses") {
        res.status(400).json({ success: false, error: "来源 API 必须为 chat 或 responses" });
        return;
      }
      if (targetApi !== "chat" && targetApi !== "responses") {
        res.status(400).json({ success: false, error: "目标 API 必须为 chat 或 responses" });
        return;
      }
      if (sourceApi === targetApi) {
        res.status(400).json({ success: false, error: "来源与目标 API 不能相同（相同则无需映射）" });
        return;
      }
      if (platformId !== undefined && platformId !== null && typeof platformId !== "string") {
        res.status(400).json({ success: false, error: "平台 ID 必须为字符串" });
        return;
      }
      const list = await loadMappings(db);
      const item: ApiMapping = {
        id: crypto.randomUUID(),
        name: name.trim(),
        description: typeof description === "string" ? description.trim() : "",
        pattern: pattern.trim(),
        targetModel: normalizedTargetModel,
        sourceApi,
        targetApi,
        platformId: platformId || null,
        enabled: enabled !== undefined ? Boolean(enabled) : true,
      };
      list.push(item);
      await saveMappings(db, list);
      res.status(200).json({ success: true, data: item, message: "映射创建成功" });
      return;
    }

    if (req.method === "PUT") {
      if (!checkCsrfOrigin(req, res)) return;
      if (!(await checkAdminRateLimit(admin.adminId, res))) return;
      const body: any = req.body;
      if (!body || typeof body !== "object" || !body.id) {
        res.status(400).json({ success: false, error: "缺少 ID" });
        return;
      }
      const { id, name, description, pattern, targetModel, sourceApi, targetApi, platformId, enabled } = body;
      const list = await loadMappings(db);
      const idx = list.findIndex((m) => m.id === id);
      if (idx === -1) {
        res.status(404).json({ success: false, error: "映射不存在" });
        return;
      }
      if (name !== undefined) {
        if (typeof name !== "string" || !name.trim()) {
          res.status(400).json({ success: false, error: "名称不能为空" });
          return;
        }
        list[idx].name = name.trim();
      }
      if (description !== undefined) {
        if (typeof description !== "string") {
          res.status(400).json({ success: false, error: "描述必须为字符串" });
          return;
        }
        list[idx].description = description.trim();
      }
      if (pattern !== undefined) {
        if (!isValidPattern(pattern)) {
          res.status(400).json({ success: false, error: "模型匹配模式不合法" });
          return;
        }
        list[idx].pattern = pattern.trim();
      }
      if (targetModel !== undefined) {
        if (typeof targetModel !== "string") {
          res.status(400).json({ success: false, error: "目标模型必须为字符串" });
          return;
        }
        list[idx].targetModel = targetModel.trim();
      }
      if (sourceApi !== undefined) {
        if (sourceApi !== "chat" && sourceApi !== "responses") {
          res.status(400).json({ success: false, error: "来源 API 必须为 chat 或 responses" });
          return;
        }
        list[idx].sourceApi = sourceApi;
      }
      if (targetApi !== undefined) {
        if (targetApi !== "chat" && targetApi !== "responses") {
          res.status(400).json({ success: false, error: "目标 API 必须为 chat 或 responses" });
          return;
        }
        list[idx].targetApi = targetApi;
      }
      if (list[idx].sourceApi === list[idx].targetApi) {
        res.status(400).json({ success: false, error: "来源与目标 API 不能相同" });
        return;
      }
      if (platformId !== undefined) {
        if (platformId !== null && typeof platformId !== "string") {
          res.status(400).json({ success: false, error: "平台 ID 必须为字符串或 null" });
          return;
        }
        list[idx].platformId = platformId || null;
      }
      if (enabled !== undefined) {
        if (typeof enabled !== "boolean") {
          res.status(400).json({ success: false, error: "启用状态必须为布尔值" });
          return;
        }
        list[idx].enabled = enabled;
      }
      await saveMappings(db, list);
      res.status(200).json({ success: true, data: list[idx], message: "更新成功" });
      return;
    }

    if (req.method === "DELETE") {
      if (!checkCsrfOrigin(req, res)) return;
      if (!(await checkAdminRateLimit(admin.adminId, res))) return;
      const id = (req.query.id as string) || (req.body?.id as string);
      if (!id) {
        res.status(400).json({ success: false, error: "缺少 ID" });
        return;
      }
      const list = await loadMappings(db);
      const idx = list.findIndex((m) => m.id === id);
      if (idx === -1) {
        res.status(404).json({ success: false, error: "映射不存在" });
        return;
      }
      list.splice(idx, 1);
      await saveMappings(db, list);
      res.status(200).json({ success: true, message: "已删除" });
      return;
    }

    res.setHeader("Allow", ["GET", "POST", "PUT", "DELETE"]);
    res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (e) {
    console.error("[api-mappings] 操作失败:", e);
    res.status(500).json({ success: false, error: "操作失败" });
  }
}
