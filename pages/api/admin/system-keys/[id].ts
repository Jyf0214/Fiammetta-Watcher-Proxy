/**
 * 单个系统 API Key 操作
 *
 * DELETE  /api/admin/system-keys/[id] — 删除系统 Key
 * PATCH   /api/admin/system-keys/[id] — 启用/禁用系统 Key
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/db";
import * as schema from "@/lib/schema";
import { eq } from "drizzle-orm";
import { getAdminFromRequest, getAuditAdminId } from "../_auth";

function generateId(): string {
  return crypto.randomUUID();
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { id } = req.query;
  if (typeof id !== "string") {
    return res.status(400).json({ success: false, error: "无效的 ID" });
  }

  switch (req.method) {
    case "DELETE":
      return handleDelete(req, res, id);
    case "PATCH":
      return handlePatch(req, res, id);
    default:
      res.setHeader("Allow", ["DELETE", "PATCH"]);
      return res.status(405).json({ success: false, error: "Method not allowed" });
  }
}

async function handleDelete(req: NextApiRequest, res: NextApiResponse, id: string) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }

  try {
    const db = await createDb();
    const existing = await db
      .select({ id: schema.systemApiKeys.id, name: schema.systemApiKeys.name })
      .from(schema.systemApiKeys)
      .where(eq(schema.systemApiKeys.id, id))
      .limit(1);

    if (existing.length === 0) {
      return res.status(404).json({ success: false, error: "系统 Key 不存在" });
    }

    await db.delete(schema.systemApiKeys).where(eq(schema.systemApiKeys.id, id));

    // 审计日志
    try {
      await db.insert(schema.auditLogs).values({
        id: generateId(),
        adminId: getAuditAdminId(admin),
        action: "delete_system_key",
        detail: JSON.stringify({ target: id, name: existing[0].name }),
        ip: null,
        createdAt: now(),
      });
    } catch {
      /* 审计日志失败不阻塞 */
    }

    return res.status(200).json({ success: true, message: "系统 Key 已删除" });
  } catch (err) {
    console.error("[DELETE /api/admin/system-keys] 删除系统 Key 失败:", err instanceof Error ? err.message : String(err));
    return res.status(500).json({ success: false, error: "删除系统 Key 失败", detail: err instanceof Error ? err.message : String(err) });
  }
}

async function handlePatch(req: NextApiRequest, res: NextApiResponse, id: string) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }

  try {
    const body = req.body as { enabled?: boolean };
    const { enabled } = body;

    if (typeof enabled !== "boolean") {
      return res.status(400).json({ success: false, error: "enabled 字段必须是布尔值" });
    }

    const db = await createDb();
    const existing = await db
      .select({ id: schema.systemApiKeys.id, name: schema.systemApiKeys.name })
      .from(schema.systemApiKeys)
      .where(eq(schema.systemApiKeys.id, id))
      .limit(1);

    if (existing.length === 0) {
      return res.status(404).json({ success: false, error: "系统 Key 不存在" });
    }

    await db
      .update(schema.systemApiKeys)
      .set({ enabled, updatedAt: now() })
      .where(eq(schema.systemApiKeys.id, id));

    return res.status(200).json({ success: true, message: enabled ? "系统 Key 已启用" : "系统 Key 已禁用" });
  } catch (err) {
    console.error("[PATCH /api/admin/system-keys] 更新系统 Key 失败:", err instanceof Error ? err.message : String(err));
    return res.status(500).json({ success: false, error: "更新系统 Key 失败", detail: err instanceof Error ? err.message : String(err) });
  }
}
