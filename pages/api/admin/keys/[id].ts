/**
 * API Key 管理 — 单个 Key 操作
 *
 * GET    /api/admin/keys/[id] — 获取单个 Key 详情
 * PUT    /api/admin/keys/[id] — 更新 API Key 属性
 * DELETE /api/admin/keys/[id] — 删除 API Key（级联删除关联日志）
 *
 * 主分支对应文件：src/app/api/admin/keys/[id]/route.ts
 * Pages Router 格式转换
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/db";
import * as schema from "@/lib/schema";
import { eq } from "drizzle-orm";
import { getAdminFromRequest, getAuditAdminId, type AuthResult } from "../_auth";

function maskKey(key: string): string {
  if (key.length > 12) return key.substring(0, 8) + "..." + key.substring(key.length - 4);
  return "***";
}

function generateId(): string { return crypto.randomUUID(); }
function now(): number { return Math.floor(Date.now() / 1000); }

function getClientIp(req: NextApiRequest): string {
  const forwarded = req.headers["x-forwarded-for"];
  const str = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return str?.split(",")[0]?.trim() || (req.headers["x-real-ip"] as string) || "unknown";
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const admin = await getAdminFromRequest(req);
  if (!admin) return res.status(401).json({ success: false, error: { message: "未授权", type: "invalid_request_error" } });

  const id = req.query.id as string;
  if (!id) return res.status(400).json({ success: false, error: { message: "缺少 Key ID", type: "invalid_request_error" } });

  switch (req.method) {
    case "GET": return handleGet(req, res, admin, id);
    case "PUT": return handlePut(req, res, admin, id);
    case "DELETE": return handleDelete(req, res, admin, id);
    default:
      res.setHeader("Allow", ["GET", "PUT", "DELETE"]);
      return res.status(405).json({ success: false, error: "Method not allowed" });
  }
}

async function handleGet(req: NextApiRequest, res: NextApiResponse, admin: { adminId: string; username: string }, id: string) {
  try {
    const db = await createDb();
    const key = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id)).get();
    if (!key) return res.status(404).json({ success: false, error: { message: "API Key 不存在", type: "invalid_request_error" } });
    return res.status(200).json({ success: true, data: { ...key, key: maskKey(key.key) } });
  } catch (err) {
    console.error("[GET /api/admin/keys/[id]] 获取 Key 详情失败:", err instanceof Error ? err.message : String(err));
    return res.status(500).json({ success: false, error: { message: "获取 Key 详情失败", type: "server_error" } });
  }
}

async function handlePut(req: NextApiRequest, res: NextApiResponse, admin: { adminId: string; username: string }, id: string) {
  try {
    const db = await createDb();
    const existing = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id)).get();
    if (!existing) return res.status(404).json({ success: false, error: { message: "API Key 不存在", type: "invalid_request_error" } });

    const body = req.body as any;
    const numericFields = ["quota", "rpmLimit", "tpmLimit", "callLimit"] as const;
    for (const field of numericFields) {
      if (body[field] !== undefined && body[field] !== null) {
        if (typeof body[field] !== "number" || !Number.isFinite(body[field]) || body[field] < 0) {
          return res.status(400).json({ success: false, error: { message: `${field} 必须是非负数`, type: "invalid_request_error" } });
        }
      }
    }
    if (body.tokenLimit !== undefined && body.tokenLimit !== null) {
      if (typeof body.tokenLimit !== "number" || !Number.isFinite(body.tokenLimit)) {
        return res.status(400).json({ success: false, error: { message: "tokenLimit 必须是有效数字", type: "invalid_request_error" } });
      }
      if (!Number.isInteger(body.tokenLimit) || body.tokenLimit < 0) {
        return res.status(400).json({ success: false, error: { message: "tokenLimit 必须是非负整数", type: "invalid_request_error" } });
      }
    }
    if (body.name !== undefined && typeof body.name === "string" && body.name.length > 100) {
      return res.status(400).json({ success: false, error: { message: "Key 名称不能超过 100 个字符", type: "invalid_request_error" } });
    }
    if (body.status !== undefined) {
      const allowed = ["active", "disabled", "expired"];
      if (!allowed.includes(body.status)) {
        return res.status(400).json({ success: false, error: { message: `status 无效，允许值：${allowed.join(", ")}`, type: "invalid_request_error" } });
      }
    }
    if (body.resetPeriod !== undefined) {
      const valid = ["monthly", "daily", "never"];
      if (!valid.includes(body.resetPeriod)) {
        return res.status(400).json({ success: false, error: { message: "重置周期必须是 monthly、daily 或 never", type: "invalid_request_error" } });
      }
    }
    if (body.planId !== undefined && body.planId !== null) {
      const planExists = await db.select({ id: schema.plans.id }).from(schema.plans).where(eq(schema.plans.id, body.planId)).get();
      if (!planExists) return res.status(400).json({ success: false, error: { message: "指定的 planId 对应的套餐不存在", type: "invalid_request_error" } });
    }

    let expiresAtTimestamp: number | null | undefined;
    if (body.expiresAt !== undefined) {
      if (body.expiresAt === null) {
        expiresAtTimestamp = null;
      } else {
        const parsed = new Date(body.expiresAt);
        if (isNaN(parsed.getTime())) return res.status(400).json({ success: false, error: { message: "expiresAt 日期格式无效", type: "invalid_request_error" } });
        expiresAtTimestamp = Math.floor(parsed.getTime() / 1000);
      }
    }

    const currentTime = now();
    const updateData: Record<string, unknown> = { updatedAt: currentTime };
    if (body.name !== undefined) updateData.name = body.name;
    if (body.planId !== undefined) updateData.planId = body.planId ?? null;
    if (body.quota !== undefined) updateData.quota = body.quota ?? null;
    if (body.rpmLimit !== undefined) updateData.rpmLimit = body.rpmLimit ?? null;
    if (body.tpmLimit !== undefined) updateData.tpmLimit = body.tpmLimit ?? null;
    if (body.callLimit !== undefined) updateData.callLimit = body.callLimit ?? null;
    if (body.tokenLimit !== undefined) updateData.tokenLimit = body.tokenLimit ?? null;
    if (body.resetPeriod !== undefined) updateData.resetPeriod = body.resetPeriod;
    if (body.status !== undefined) updateData.status = body.status;
    if (body.enabled !== undefined) updateData.enabled = body.enabled ? 1 : 0;
    if (expiresAtTimestamp !== undefined) updateData.expiresAt = expiresAtTimestamp;

    const updated = await db.update(schema.apiKeys).set(updateData).where(eq(schema.apiKeys.id, id)).returning().get();

    const sanitizedChanges = { ...body };
    if (sanitizedChanges.key) sanitizedChanges.key = String(sanitizedChanges.key).substring(0, 8) + "***";

    const ip = getClientIp(req);
    await db.insert(schema.auditLogs).values({
      id: generateId(), adminId: getAuditAdminId(admin), action: "update_api_key",
      detail: JSON.stringify({ target: id, keyId: id, changes: sanitizedChanges }),
      ip, createdAt: currentTime,
    } as any);

    return res.status(200).json({ success: true, data: { ...updated, key: maskKey(updated.key) }, message: "API Key 更新成功" });
  } catch (err) {
    console.error("[PUT /api/admin/keys/[id]] 更新失败:", err instanceof Error ? err.message : String(err));
    return res.status(500).json({ success: false, error: { message: "更新 API Key 失败", type: "server_error" } });
  }
}

async function handleDelete(req: NextApiRequest, res: NextApiResponse, admin: { adminId: string; username: string }, id: string) {
  try {
    const db = await createDb();
    const existing = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id)).get();
    if (!existing) return res.status(404).json({ success: false, error: { message: "API Key 不存在", type: "invalid_request_error" } });

    const deletedLogs = await db.delete(schema.requestLogs).where(eq(schema.requestLogs.keyId, id)).returning();
    await db.delete(schema.apiKeys).where(eq(schema.apiKeys.id, id));

    const currentTime = now();
    const ip = getClientIp(req);
    await db.insert(schema.auditLogs).values({
      id: generateId(), adminId: getAuditAdminId(admin), action: "delete_api_key",
      detail: JSON.stringify({ target: id, keyId: id, name: existing.name, deletedLogs: deletedLogs.length }),
      ip, createdAt: currentTime,
    } as any);

    return res.status(200).json({ success: true, message: "API Key 删除成功", deletedLogs: deletedLogs.length });
  } catch (err) {
    console.error("[DELETE /api/admin/keys/[id]] 删除失败:", err instanceof Error ? err.message : String(err));
    return res.status(500).json({ success: false, error: { message: "删除 API Key 失败", type: "server_error" } });
  }
}
