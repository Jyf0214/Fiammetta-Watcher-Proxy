/**
 * API Key 管理 — 列表与创建
 *
 * GET  /api/admin/keys — 获取 API Key 列表（含套餐信息，密钥掩码处理）
 * POST /api/admin/keys — 创建新 API Key
 *
 * 主分支对应文件：src/app/api/admin/keys/route.ts
 * Pages Router 格式转换
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/db";
import * as schema from "@/lib/schema";
import { eq, desc } from "drizzle-orm";
import { verifyToken } from "@/lib/auth";

const COOKIE_NAME = "admin_token";

async function getAdminFromRequest(req: NextApiRequest): Promise<{ adminId: string; username: string } | null> {
  try {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return null;
    let token: string | null = null;
    for (const cookie of cookieHeader.split(";")) {
      const [name, ...rest] = cookie.trim().split("=");
      if (name === COOKIE_NAME) { token = rest.join("="); break; }
    }
    if (!token) return null;
    const payload = await verifyToken(token, { JWT_SECRET: process.env.JWT_SECRET });
    if (!payload || !payload.adminId || !payload.username) return null;
    return { adminId: payload.adminId as string, username: payload.username as string };
  } catch { return null; }
}

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

function getClientIp(req: NextApiRequest): string {
  const forwarded = req.headers["x-forwarded-for"];
  const str = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return str?.split(",")[0]?.trim() || (req.headers["x-real-ip"] as string) || "unknown";
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
  if (!admin) return res.status(401).json({ success: false, error: { message: "未授权", type: "invalid_request_error" } });

  try {
    const db = createDb((process.env as unknown as { DB: D1Database }).DB);
    const keys = await db.select().from(schema.apiKeys).orderBy(desc(schema.apiKeys.createdAt));
    const maskedKeys = keys.map((k) => ({ ...k, key: maskKey(k.key) }));
    return res.status(200).json({ success: true, data: maskedKeys, total: maskedKeys.length });
  } catch (err) {
    console.error("[GET /api/admin/keys] 获取 Key 列表失败:", err instanceof Error ? err.message : String(err));
    return res.status(500).json({ success: false, error: { message: "获取 Key 列表失败", type: "server_error" } });
  }
}

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  const admin = await getAdminFromRequest(req);
  if (!admin) return res.status(401).json({ success: false, error: { message: "未授权", type: "invalid_request_error" } });

  try {
    const body = req.body as any;
    const { name, planId, quota, rpmLimit, tpmLimit, callLimit, tokenLimit, resetPeriod, expiresAt } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return res.status(400).json({ success: false, error: { message: "Key 名称不能为空", type: "invalid_request_error" } });
    }
    if (name.length > 100) {
      return res.status(400).json({ success: false, error: { message: "Key 名称不能超过 100 个字符", type: "invalid_request_error" } });
    }

    const validResetPeriods = ["monthly", "daily", "never"];
    if (resetPeriod && !validResetPeriods.includes(resetPeriod)) {
      return res.status(400).json({ success: false, error: { message: "重置周期必须是 monthly、daily 或 never", type: "invalid_request_error" } });
    }

    if (quota !== undefined && quota !== null && (typeof quota !== "number" || !Number.isFinite(quota) || quota < 0)) {
      return res.status(400).json({ success: false, error: { message: "配额必须是非负数", type: "invalid_request_error" } });
    }
    if (rpmLimit !== undefined && rpmLimit !== null && (typeof rpmLimit !== "number" || !Number.isFinite(rpmLimit) || rpmLimit < 0)) {
      return res.status(400).json({ success: false, error: { message: "RPM 限制必须是非负数", type: "invalid_request_error" } });
    }
    if (tpmLimit !== undefined && tpmLimit !== null && (typeof tpmLimit !== "number" || !Number.isFinite(tpmLimit) || tpmLimit < 0)) {
      return res.status(400).json({ success: false, error: { message: "TPM 限制必须是非负数", type: "invalid_request_error" } });
    }
    if (callLimit !== undefined && callLimit !== null && (typeof callLimit !== "number" || !Number.isFinite(callLimit) || callLimit < 0)) {
      return res.status(400).json({ success: false, error: { message: "调用次数限制必须是非负数", type: "invalid_request_error" } });
    }
    if (tokenLimit !== undefined && tokenLimit !== null && (typeof tokenLimit !== "number" || !Number.isInteger(tokenLimit) || tokenLimit < 0)) {
      return res.status(400).json({ success: false, error: { message: "Token 限制必须是非负整数", type: "invalid_request_error" } });
    }

    if (planId !== undefined && planId !== null) {
      const db = createDb((process.env as unknown as { DB: D1Database }).DB);
      const planExists = await db.select({ id: schema.plans.id }).from(schema.plans).where(eq(schema.plans.id, planId)).get();
      if (!planExists) {
        return res.status(400).json({ success: false, error: { message: "指定的 planId 对应的套餐不存在", type: "invalid_request_error" } });
      }
    }

    let expiresAtTimestamp: number | null = null;
    if (expiresAt) {
      const parsed = new Date(expiresAt);
      if (isNaN(parsed.getTime())) {
        return res.status(400).json({ success: false, error: { message: "expiresAt 日期格式无效", type: "invalid_request_error" } });
      }
      expiresAtTimestamp = Math.floor(parsed.getTime() / 1000);
    }

    const db = createDb((process.env as unknown as { DB: D1Database }).DB);
    const keyId = generateId();
    const keyValue = generateApiKey();
    const currentTime = now();

    const newKey = await db.insert(schema.apiKeys).values({
      id: keyId, key: keyValue, name: name.trim(), planId: planId ?? null,
      quota: quota ?? null, usedTokens: 0, rpmLimit: rpmLimit ?? null,
      tpmLimit: tpmLimit ?? null, callLimit: callLimit ?? null, callUsed: 0,
      tokenLimit: tokenLimit ?? null, resetPeriod: resetPeriod || "monthly",
      status: "active", expiresAt: expiresAtTimestamp, enabled: true,
      createdAt: currentTime, updatedAt: currentTime,
    } as any).returning().get();

    const ip = getClientIp(req);
    await db.insert(schema.auditLogs).values({
      id: generateId(), adminId: admin.adminId, action: "create_api_key",
      detail: JSON.stringify({ target: keyId, keyId, name: name.trim() }),
      ip, createdAt: currentTime,
    } as any);

    return res.status(200).json({ success: true, data: newKey, message: "API Key 创建成功" });
  } catch (err) {
    console.error("[POST /api/admin/keys] 创建 Key 失败:", err instanceof Error ? err.message : String(err));
    return res.status(500).json({ success: false, error: { message: "创建 Key 失败", type: "server_error" } });
  }
}
