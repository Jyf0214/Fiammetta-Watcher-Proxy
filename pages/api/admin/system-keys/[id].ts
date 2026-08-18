/**
 * 单个系统 API Key 操作
 *
 * GET    /api/admin/system-keys/[id] — 获取单个系统 Key 的完整密钥（列表接口只返回掩码，
 *        复制功能需要先经此端点取明文；管理员认证即可，读操作无 CSRF 风险）
 * DELETE /api/admin/system-keys/[id] — 删除系统 Key
 * PATCH  /api/admin/system-keys/[id] — 启用/禁用系统 Key
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest, getAuditAdminId } from "@/lib/admin-auth";
import { checkCsrfOrigin } from "@/lib/admin-security";
import { checkAdminRateLimit } from "@/lib/admin-rate-limit";

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
    case "GET":
      return handleGetSecret(req, res, id);
    case "DELETE":
      return handleDelete(req, res, id);
    case "PATCH":
      return handlePatch(req, res, id);
    default:
      res.setHeader("Allow", ["GET", "DELETE", "PATCH"]);
      return res.status(405).json({ success: false, error: "Method not allowed" });
  }
}

/** 获取单个系统 Key 的完整密钥（列表接口只返回掩码，复制功能需先经此端点取明文） */
async function handleGetSecret(req: NextApiRequest, res: NextApiResponse, id: string) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }

  try {
    const db = await createDb();
    const existing = await db.systemApiKeys.findFirst({
      where: { id },
      select: { id: true, key: true, name: true },
    });

    if (!existing) {
      return res.status(404).json({ success: false, error: "系统 Key 不存在" });
    }

    // 明文系统级凭据不可被任何中间缓存留存
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ success: true, key: existing.key });
  } catch (err) {
    console.error("[GET /api/admin/system-keys/[id]] 获取系统 Key 失败:", err instanceof Error ? err.message : String(err));
    return res.status(500).json({ success: false, error: "获取系统 Key 失败" });
  }
}

async function handleDelete(req: NextApiRequest, res: NextApiResponse, id: string) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }

  if (!checkCsrfOrigin(req, res)) return;
  if (!(await checkAdminRateLimit(admin.adminId, res))) return;

  try {
    const db = await createDb();
    const existing = await db.systemApiKeys.findFirst({
      where: { id },
      select: { id: true, name: true },
    });

    if (!existing) {
      return res.status(404).json({ success: false, error: "系统 Key 不存在" });
    }

    await db.systemApiKeys.delete({ where: { id } });

    // 审计日志
    try {
      await db.auditLogs.create({
        data: {
          id: generateId(),
          adminId: getAuditAdminId(admin),
          action: "delete_system_key",
          detail: JSON.stringify({ target: id, name: existing.name }),
          ip: null,
          createdAt: now(),
        },
      });
    } catch {
      /* 审计日志失败不阻塞 */
    }

    return res.status(200).json({ success: true, message: "系统 Key 已删除" });
  } catch (err) {
    console.error("[DELETE /api/admin/system-keys] 删除系统 Key 失败:", err instanceof Error ? err.message : String(err));
    return res.status(500).json({ success: false, error: "删除系统 Key 失败" });
  }
}

async function handlePatch(req: NextApiRequest, res: NextApiResponse, id: string) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }

  if (!checkCsrfOrigin(req, res)) return;
  if (!(await checkAdminRateLimit(admin.adminId, res))) return;

  try {
    const body = req.body as { enabled?: boolean };
    const { enabled } = body;

    if (typeof enabled !== "boolean") {
      return res.status(400).json({ success: false, error: "enabled 字段必须是布尔值" });
    }

    const db = await createDb();
    const existing = await db.systemApiKeys.findFirst({
      where: { id },
      select: { id: true, name: true },
    });

    if (!existing) {
      return res.status(404).json({ success: false, error: "系统 Key 不存在" });
    }

    await db.systemApiKeys.update({
      where: { id },
      data: { enabled, updatedAt: now() },
    });

    return res.status(200).json({ success: true, message: enabled ? "系统 Key 已启用" : "系统 Key 已禁用" });
  } catch (err) {
    console.error("[PATCH /api/admin/system-keys] 更新系统 Key 失败:", err instanceof Error ? err.message : String(err));
    return res.status(500).json({ success: false, error: "更新系统 Key 失败" });
  }
}
