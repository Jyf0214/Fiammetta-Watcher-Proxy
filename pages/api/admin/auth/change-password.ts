/**
 * 密码修改 API
 *
 * POST /api/admin/auth/change-password — 管理员修改密码
 *
 * 要求：管理员已登录（携带有效 Cookie），验证旧密码后修改为新密码。
 * 速率限制：5 次 / 15 分钟 / IP，防止暴力尝试。
 *
 * 主分支对应文件：src/app/api/admin/auth/change-password/route.ts
 * Pages Router 格式转换
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { eq } from "drizzle-orm";
import { verifyToken, hashPassword } from "@/lib/auth";
import { verifyPassword } from "@/lib/auth-helpers";
import { createDb } from "@/lib/db";
import * as schema from "@/lib/schema";

const COOKIE_NAME = "admin_token";

interface ChangeAttemptEntry {
  count: number;
  windowStart: number;
}

const changeAttempts = new Map<string, ChangeAttemptEntry>();
const CHANGE_MAX_ATTEMPTS = 5;
const CHANGE_WINDOW_MS = 15 * 60 * 1000;

function cleanupChangeAttempts() {
  const now = Date.now();
  for (const [ip, entry] of changeAttempts.entries()) {
    if (now - entry.windowStart >= CHANGE_WINDOW_MS) changeAttempts.delete(ip);
  }
}

function checkChangeRateLimit(ip: string): boolean {
  const now = Date.now();
  cleanupChangeAttempts();
  const entry = changeAttempts.get(ip);
  if (!entry || now - entry.windowStart >= CHANGE_WINDOW_MS) {
    changeAttempts.set(ip, { count: 0, windowStart: now });
    return false;
  }
  return entry.count >= CHANGE_MAX_ATTEMPTS;
}

function recordChangeFailure(ip: string): void {
  const now = Date.now();
  const entry = changeAttempts.get(ip);
  if (!entry || now - entry.windowStart >= CHANGE_WINDOW_MS) {
    changeAttempts.set(ip, { count: 1, windowStart: now });
  } else {
    entry.count += 1;
  }
}

function clearChangeFailures(ip: string): void {
  changeAttempts.delete(ip);
}

function getClientIp(req: NextApiRequest): string {
  const forwarded = req.headers["x-forwarded-for"];
  const str = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return str?.split(",")[0]?.trim() || (req.headers["x-real-ip"] as string) || "unknown";
}

function getTokenFromCookie(req: NextApiRequest): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  for (const cookie of cookieHeader.split(";")) {
    const [name, ...rest] = cookie.trim().split("=");
    if (name === COOKIE_NAME) return rest.join("=");
  }
  return null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  const env = {
    JWT_SECRET: process.env.JWT_SECRET,
    DB: (process.env as unknown as { DB: D1Database }).DB,
  };

  if (!env.JWT_SECRET) return res.status(500).json({ success: false, error: "JWT_SECRET 环境变量未配置" });
  if (!env.DB) return res.status(500).json({ success: false, error: "数据库未配置" });

  try {
    const clientIp = getClientIp(req);
    if (checkChangeRateLimit(clientIp)) {
      const entry = changeAttempts.get(clientIp);
      const resetAt = entry ? new Date(entry.windowStart + CHANGE_WINDOW_MS).toISOString() : new Date().toISOString();
      return res.status(429).json({ success: false, error: "密码修改尝试次数过多，请稍后再试", resetAt });
    }

    const token = getTokenFromCookie(req);
    if (!token) return res.status(401).json({ success: false, error: "未授权" });

    const payload = await verifyToken(token, env);
    if (!payload) return res.status(401).json({ success: false, error: "登录已过期" });

    const body = req.body as { currentPassword?: string; newPassword?: string; confirmPassword?: string } | undefined;
    if (!body || typeof body !== "object") return res.status(400).json({ success: false, error: "请求格式错误" });

    const { currentPassword, newPassword, confirmPassword } = body;
    if (!currentPassword || !newPassword || !confirmPassword) return res.status(400).json({ success: false, error: "所有字段均为必填" });
    if (typeof newPassword !== "string" || newPassword.length < 8) return res.status(400).json({ success: false, error: "新密码至少需要 8 个字符" });
    if (newPassword.length > 128) return res.status(400).json({ success: false, error: "新密码长度不能超过 128 个字符" });
    if (newPassword !== confirmPassword) return res.status(400).json({ success: false, error: "两次输入的新密码不一致" });

    const db = createDb(env.DB);
    const [adminRecord] = await db.select().from(schema.admins).where(eq(schema.admins.id, payload.adminId)).limit(1);
    if (!adminRecord) return res.status(401).json({ success: false, error: "管理员账户不存在" });

    const isValid = await verifyPassword(currentPassword, adminRecord.passwordHash);
    if (!isValid) {
      recordChangeFailure(clientIp);
      try {
        await db.insert(schema.auditLogs).values({
          id: crypto.randomUUID(), adminId: payload.adminId, action: "change_password_failed",
          detail: "当前密码错误", ip: clientIp, createdAt: Math.floor(Date.now() / 1000),
        } as any);
      } catch { /* 审计日志写入失败不阻塞主流程 */ }
      return res.status(400).json({ success: false, error: "当前密码错误" });
    }

    const newHash = await hashPassword(newPassword);
    await db.update(schema.admins).set({ passwordHash: newHash, updatedAt: Math.floor(Date.now() / 1000) } as any).where(eq(schema.admins.id, payload.adminId));
    clearChangeFailures(clientIp);

    try {
      await db.insert(schema.auditLogs).values({
        id: crypto.randomUUID(), adminId: payload.adminId, action: "change_password",
        detail: "密码已修改", ip: clientIp, createdAt: Math.floor(Date.now() / 1000),
      } as any);
    } catch { /* 审计日志写入失败不阻塞主流程 */ }

    return res.status(200).json({ success: true, message: "密码修改成功" });
  } catch (error) {
    console.error("[auth] 修改密码异常:", error instanceof Error ? error.message : String(error));
    return res.status(500).json({ success: false, error: "密码修改失败，请稍后重试" });
  }
}
