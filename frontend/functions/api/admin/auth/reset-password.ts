/**
 * POST /api/admin/auth/reset-password — 重置密码
 *
 * 需要管理员登录。直接更新密码哈希。
 */

import { type PagesFunction } from "@cloudflare/workers-types";
import { hashPassword } from "../../lib/auth";

interface Env {
  DB: D1Database;
  JWT_SECRET?: string;
  JWKS_KEY?: string;
  ENVIRONMENT?: string;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const admin = (context.data as { admin: { adminId: string; username: string } }).admin;
  const db = (context.data as { db: ReturnType<typeof import("../../lib/db").createDb> }).db;

  let body: { newPassword?: string };
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ success: false, error: "请求格式错误" }, { status: 400 });
  }

  const { newPassword } = body;
  if (!newPassword) {
    return Response.json({ success: false, error: "新密码不能为空" }, { status: 400 });
  }

  const { admins } = await import("../../lib/schema");
  const { eq } = await import("drizzle-orm");
  const newHash = await hashPassword(newPassword);
  const now = new Date().toISOString();
  await db.update(admins).set({ passwordHash: newHash, updatedAt: now }).where(eq(admins.id, admin.adminId)).run();

  return Response.json({ success: true, message: "密码重置成功" });
};
