/**
 * POST /api/admin/auth/change-password — 修改密码
 *
 * 验证旧密码 → 更新密码哈希（存储在 DB 中）
 */

import { type PagesFunction } from "@cloudflare/workers-types";
import { verifyPassword, hashPassword } from "../../../../lib/auth";

interface Env {
  DB: D1Database;
  JWT_SECRET?: string;
  JWKS_KEY?: string;
  ENVIRONMENT?: string;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const admin = (context.data as { admin: { adminId: string; username: string } }).admin;
  const db = (context.data as { db: ReturnType<typeof import("../../../../lib/db").createDb> }).db;

  let body: { currentPassword?: string; newPassword?: string };
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ success: false, error: "请求格式错误" }, { status: 400 });
  }

  const { currentPassword, newPassword } = body;
  if (!currentPassword || !newPassword) {
    return Response.json({ success: false, error: "当前密码和新密码不能为空" }, { status: 400 });
  }

  if (newPassword.length > 128) {
    return Response.json({ success: false, error: "新密码长度不能超过 128 个字符" }, { status: 400 });
  }

  // 获取当前密码哈希
  const { admins } = await import("../../../../lib/schema");
  const { eq } = await import("drizzle-orm");
  const adminRow = await db.select().from(admins).where(eq(admins.id, admin.adminId)).get();

  if (!adminRow) {
    return Response.json({ success: false, error: "管理员不存在" }, { status: 404 });
  }

  // 验证旧密码
  const valid = await verifyPassword(currentPassword, adminRow.passwordHash);
  if (!valid) {
    return Response.json({ success: false, error: "当前密码错误" }, { status: 401 });
  }

  // 更新密码
  const newHash = await hashPassword(newPassword);
  const now = new Date().toISOString();
  await db.update(admins).set({ passwordHash: newHash, updatedAt: now }).where(eq(admins.id, admin.adminId)).run();

  return Response.json({ success: true, message: "密码修改成功" });
};
