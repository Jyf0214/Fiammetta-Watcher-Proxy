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
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest, getAuditAdminId } from "@/lib/admin-auth";
import { checkCsrfOrigin } from "@/lib/admin-security";
import { checkAdminRateLimit } from "@/lib/admin-rate-limit";

// ==================== 工具函数 ====================

function maskKey(key: string): string {
  if (key.length > 12) return key.substring(0, 8) + "..." + key.substring(key.length - 4);
  return "***";
}

export function generateSystemKey(): string {
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

/** 解析分页 limit（钳制 1~500，缺省/非法取默认 50） */
function parseLimitParam(raw: string | string[] | undefined): number {
  if (raw === undefined) return 50;
  const n = parseInt(Array.isArray(raw) ? raw[0] : raw, 10);
  if (Number.isNaN(n)) return 50;
  return Math.min(500, Math.max(1, n));
}

/** 解析分页 offset（非负整数，缺省/非法取 0） */
function parseOffsetParam(raw: string | string[] | undefined): number {
  if (raw === undefined) return 0;
  const n = parseInt(Array.isArray(raw) ? raw[0] : raw, 10);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, n);
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
    const query = req.query || {};
    const hasPaging = query.limit !== undefined || query.offset !== undefined;

    // 带 limit/offset 参数时返回分页形态 { total, items }；不带参数保持原数组形态（向后兼容）
    if (hasPaging) {
      const limit = parseLimitParam(query.limit);
      const offset = parseOffsetParam(query.offset);
      const [total, keys] = await Promise.all([
        db.systemApiKeys.count(),
        db.systemApiKeys.findMany({ orderBy: { createdAt: "desc" }, take: limit, skip: offset }),
      ]);
      const maskedKeys = keys.map((k) => ({
        ...k,
        key: maskKey(k.key),
      }));
      return res.status(200).json({ success: true, data: { total, items: maskedKeys } });
    }

    const keys = await db.systemApiKeys.findMany({
      orderBy: { createdAt: "desc" },
    });

    const maskedKeys = keys.map((k) => ({
      ...k,
      key: maskKey(k.key),
    }));

    return res.status(200).json({ success: true, data: maskedKeys, total: maskedKeys.length });
  } catch (err) {
    console.error("[GET /api/admin/system-keys] 获取系统 Key 列表失败:", err instanceof Error ? err.message : String(err));
    return res.status(500).json({ success: false, error: "获取系统 Key 列表失败" });
  }
}

// ==================== POST — 创建 ====================

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }

  if (!checkCsrfOrigin(req, res)) return;
  if (!(await checkAdminRateLimit(admin.adminId, res))) return;

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

    const newKey = await db.systemApiKeys.create({
      data: {
        id: keyId,
        key: keyValue,
        name: name.trim(),
        enabled: true,
        createdAt: currentTime,
        updatedAt: currentTime,
      },
    });

    // 审计日志
    try {
      await db.auditLogs.create({
        data: {
          id: generateId(),
          adminId: getAuditAdminId(admin),
          action: "create_system_key",
          detail: JSON.stringify({ target: keyId, name: name.trim() }),
          ip: null,
          createdAt: currentTime,
        },
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
    return res.status(500).json({ success: false, error: "创建系统 Key 失败" });
  }
}
