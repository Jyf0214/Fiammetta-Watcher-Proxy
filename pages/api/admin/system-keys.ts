/**
 * 系统 API Key 管理 — 列表与创建
 *
 * GET  /api/admin/system-keys — 获取系统 Key 列表（密钥掩码）
 * POST /api/admin/system-keys — 创建新系统 Key（返回完整密钥，仅此一次）
 *
 * 系统 Key 仅用于管理后台 API 认证（Authorization: Bearer），
 * 不可用于 v1 代理转发（Worker 不认此表）。
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/db";
import * as schema from "@/lib/schema";
import { desc } from "drizzle-orm";
import { getAdminFromRequest, getAuditAdminId } from "./_auth";

// ==================== 工具函数 ====================

function maskKey(key: string): string {
  if (key.length > 12) return key.substring(0, 8) + "..." + key.substring(key.length - 4);
  return "***";
}

function generateSystemKey(): string {
  const array = new Uint8Array(24);
  crypto.getRandomValues(array);
  const hex = Array.from(array).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sk-sys-${hex}`;
}

function generateId(): string {
  return crypto.randomUUID();
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

// ==================== Handler ====================

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  switch (req.method) {
    case "GET":
      return handleGet(req, res);
    case "POST":
      return handlePost(req, res);
    default:
      res.setHeader("Allow", ["GET", "POST"]);
      return res.status(405).json({ success: false, error: "Method not allowed" });
  }
}

// ==================== GET — 列表 ====================

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }

  try {
    const db = await createDb();
    const keys = await db
      .select()
      .from(schema.systemApiKeys)
      .orderBy(desc(schema.systemApiKeys.createdAt));

    const maskedKeys = keys.map((k) => ({
      ...k,
      key: maskKey(k.key),
    }));

    return res.status(200).json({ success: true, data: maskedKeys, total: maskedKeys.length });
  } catch (err) {
    console.error("[GET /api/admin/system-keys] 获取系统 Key 列表失败:", err instanceof Error ? err.message : String(err));
    return res.status(500).json({ success: false, error: "获取系统 Key 列表失败", detail: err instanceof Error ? err.message : String(err) });
  }
}

// ==================== POST — 创建 ====================

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }

  try {
    const body = req.body as { name?: string };
    const { name } = body || {};

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return res.status(400).json({ success: false, error: "Key 名称不能为空" });
    }
    if (name.length > 100) {
      return res.status(400).json({ success: false, error: "Key 名称不能超过 100 个字符" });
    }

    const db = await createDb();
    const keyId = generateId();
    const keyValue = generateSystemKey();
    const currentTime = now();

    const newKey = await db
      .insert(schema.systemApiKeys)
      .values({
        id: keyId,
        key: keyValue,
        name: name.trim(),
        enabled: true,
        createdAt: currentTime,
        updatedAt: currentTime,
      })
      .returning()
      .get();

    // 审计日志
    try {
      await db.insert(schema.auditLogs).values({
        id: generateId(),
        adminId: getAuditAdminId(admin),
        action: "create_system_key",
        detail: JSON.stringify({ target: keyId, name: name.trim() }),
        ip: null,
        createdAt: currentTime,
      });
    } catch {
      /* 审计日志失败不阻塞 */
    }

    // 返回完整 key（仅此一次）
    return res.status(200).json({
      success: true,
      data: newKey,
      message: "系统 Key 创建成功，请妥善保存，密钥仅显示一次",
    });
  } catch (err) {
    console.error("[POST /api/admin/system-keys] 创建系统 Key 失败:", err instanceof Error ? err.message : String(err));
    return res.status(500).json({ success: false, error: "创建系统 Key 失败", detail: err instanceof Error ? err.message : String(err) });
  }
}
