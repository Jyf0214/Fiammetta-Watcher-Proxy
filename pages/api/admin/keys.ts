/**
 * API Key 管理 — 列表与创建
 *
 * GET  /api/admin/keys — 获取 API Key 列表（密钥掩码处理）
 * POST /api/admin/keys — 创建新 API Key
 *
 * 主分支对应文件：src/app/api/admin/keys/route.ts
 * Pages Router 格式转换
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest, getAuditAdminId } from "@/lib/admin-auth";
import { getClientIp } from "./auth";
import { checkAdminRateLimit } from "@/lib/admin-rate-limit";
import { checkCsrfOrigin } from "@/lib/admin-security";
import { invalidateApiKeyCache } from "../../../worker/src/auth";
import { resetAllowlistCache } from "../../../worker/src/api-key-allowlist";

function maskKey(key: string): string {
  if (key.length > 12) return key.substring(0, 8) + "..." + key.substring(key.length - 4);
  return "***";
}

function generateApiKey(): string {
  const array = new Uint8Array(24);
  crypto.getRandomValues(array);
  const hex = Array.from(array).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sk-${hex}`;
}

function generateId(): string { return crypto.randomUUID(); }
function now(): number { return Math.floor(Date.now() / 1000); }

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

/**
 * 解析白名单字段（IP 段或模型 ID 列表）
 * - null/undefined → null（不限制）
 * - 字符串数组 → JSON 字符串存储
 * - 空数组 → null（视为不限制，与空字符串等价）
 * - 非数组 → 拒绝
 */
function parseAllowlistField(value: unknown, fieldName: string): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (!Array.isArray(value)) {
    return { ok: false, error: `${fieldName} 必须是字符串数组` };
  }
  if (value.length === 0) return { ok: true, value: null };
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      return { ok: false, error: `${fieldName} 数组元素必须是非空字符串` };
    }
    if (item.length > 200) {
      return { ok: false, error: `${fieldName} 数组元素长度不能超过 200 字符` };
    }
  }
  return { ok: true, value: JSON.stringify(value) };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  switch (req.method) {
    case "GET": return handleGet(req, res);
    case "POST": return handlePost(req, res);
    default:
      res.setHeader("Allow", ["GET", "POST"]);
      return res.status(405).json({ success: false, error: "Method not allowed" });
  }
}

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const admin = await getAdminFromRequest(req);
  if (!admin) return res.status(401).json({ success: false, error: "未授权" });

  try {
    const db = await createDb();
    const query = req.query || {};
    const hasPaging = query.limit !== undefined || query.offset !== undefined;

    // 带 limit/offset 参数时返回分页形态 { total, items }；不带参数保持原数组形态（向后兼容）
    if (hasPaging) {
      const limit = parseLimitParam(query.limit);
      const offset = parseOffsetParam(query.offset);
      const [total, keys] = await Promise.all([
        db.apiKeys.count(),
        db.apiKeys.findMany({ orderBy: { createdAt: "desc" }, take: limit, skip: offset }),
      ]);
      const maskedKeys = keys.map((k) => ({ ...k, key: maskKey(k.key), usedTokens: Number(k.usedTokens) }));
      return res.status(200).json({ success: true, data: { total, items: maskedKeys } });
    }

    const keys = await db.apiKeys.findMany({ orderBy: { createdAt: "desc" } });
    const maskedKeys = keys.map((k) => ({ ...k, key: maskKey(k.key), usedTokens: Number(k.usedTokens) }));
    return res.status(200).json({ success: true, data: maskedKeys, total: maskedKeys.length });
  } catch (err) {
    console.error("[GET /api/admin/keys] 获取 Key 列表失败:", err instanceof Error ? err.message : String(err));
    return res.status(500).json({ success: false, error: { message: "获取 Key 列表失败", type: "server_error" } });
  }
}

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  const admin = await getAdminFromRequest(req);
  if (!admin) return res.status(401).json({ success: false, error: "未授权" });
  if (!checkCsrfOrigin(req, res)) return;
  if (!await checkAdminRateLimit(admin.adminId, res)) return;

  try {
    const body = req.body as any;
    const { name, rpmLimit, tpmLimit, callLimit, tokenLimit, resetPeriod, expiresAt, allowedIps, allowedModels } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return res.status(400).json({ success: false, error: { message: "Key 名称不能为空", type: "invalid_request_error" } });
    }
    if (name.length > 100) {
      return res.status(400).json({ success: false, error: { message: "Key 名称不能超过 100 个字符", type: "invalid_request_error" } });
    }

    const allowedIpsParse = parseAllowlistField(allowedIps, "allowedIps");
    if (!allowedIpsParse.ok) {
      return res.status(400).json({ success: false, error: { message: allowedIpsParse.error, type: "invalid_request_error" } });
    }
    const allowedModelsParse = parseAllowlistField(allowedModels, "allowedModels");
    if (!allowedModelsParse.ok) {
      return res.status(400).json({ success: false, error: { message: allowedModelsParse.error, type: "invalid_request_error" } });
    }

    const validResetPeriods = ["monthly", "daily", "never"];
    if (resetPeriod && !validResetPeriods.includes(resetPeriod)) {
      return res.status(400).json({ success: false, error: { message: "重置周期必须是 monthly、daily 或 never", type: "invalid_request_error" } });
    }

    if (rpmLimit !== undefined && rpmLimit !== null && (typeof rpmLimit !== "number" || !Number.isInteger(rpmLimit) || rpmLimit < 0)) {
      return res.status(400).json({ success: false, error: { message: "RPM 限制必须是非负整数", type: "invalid_request_error" } });
    }
    if (tpmLimit !== undefined && tpmLimit !== null && (typeof tpmLimit !== "number" || !Number.isInteger(tpmLimit) || tpmLimit < 0)) {
      return res.status(400).json({ success: false, error: { message: "TPM 限制必须是非负整数", type: "invalid_request_error" } });
    }
    if (callLimit !== undefined && callLimit !== null && (typeof callLimit !== "number" || !Number.isInteger(callLimit) || callLimit < 0)) {
      return res.status(400).json({ success: false, error: { message: "调用次数限制必须是非负整数", type: "invalid_request_error" } });
    }
    if (tokenLimit !== undefined && tokenLimit !== null && (typeof tokenLimit !== "number" || !Number.isInteger(tokenLimit) || tokenLimit < 0)) {
      return res.status(400).json({ success: false, error: { message: "Token 限制必须是非负整数", type: "invalid_request_error" } });
    }

    let expiresAtTimestamp: number | null = null;
    if (expiresAt) {
      const parsed = new Date(expiresAt);
      if (isNaN(parsed.getTime())) {
        return res.status(400).json({ success: false, error: { message: "expiresAt 日期格式无效", type: "invalid_request_error" } });
      }
      expiresAtTimestamp = Math.floor(parsed.getTime() / 1000);
    }

    const db = await createDb();
    const keyId = generateId();
    const keyValue = generateApiKey();
    const currentTime = now();

    // 审计先于 Key 创建：审计写入失败时主流程抛错返回 500，Key 不会落库
    // ——避免「Key 已创建但无审计」的假成功（与 config.ts 写入语义一致；
    // TiDB HTTP 适配器下 $transaction 不可依赖，改为按顺序先审计后写入）
    const ip = getClientIp(req);
    await db.auditLogs.create({
      data: {
        id: generateId(), adminId: getAuditAdminId(admin), action: "create_api_key",
        detail: JSON.stringify({ target: keyId, keyId, name: name.trim() }),
        ip, createdAt: currentTime,
      },
    });

    const newKey = await db.apiKeys.create({
      data: {
        id: keyId, key: keyValue, name: name.trim(),
        usedTokens: 0, rpmLimit: rpmLimit ?? null,
        tpmLimit: tpmLimit ?? null, callLimit: callLimit ?? null, callUsed: 0,
        tokenLimit: tokenLimit ?? null, resetPeriod: resetPeriod || "monthly",
        allowedIps: allowedIpsParse.value,
        allowedModels: allowedModelsParse.value,
        status: "active", expiresAt: expiresAtTimestamp,
        createdAt: currentTime, updatedAt: currentTime,
      },
    });

    // 创建后立即失效该 Key 的进程内缓存（5s TTL 内仍会按过期白名单拒绝/放行）
    invalidateApiKeyCache(keyValue);
    // 白名单解析缓存（CIDR 规则 + 模型列表）进程内全量清除：廉价且按需触发
    resetAllowlistCache();

    return res.status(200).json({ success: true, data: { ...newKey, usedTokens: Number(newKey.usedTokens) }, message: "API Key 创建成功" });
  } catch (err) {
    console.error("[POST /api/admin/keys] 创建 Key 失败:", err instanceof Error ? err.message : String(err));
    return res.status(500).json({ success: false, error: { message: "创建 Key 失败", type: "server_error" } });
  }
}
