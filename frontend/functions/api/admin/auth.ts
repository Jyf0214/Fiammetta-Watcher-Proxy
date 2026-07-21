/**
 * POST /api/admin/auth — 管理员登录
 *
 * 从环境变量读取 ADMIN_USERNAME + ADMIN_PASSWORD 进行验证。
 * 验证通过后签发 JWT 并设置 HttpOnly Cookie。
 */

import { type PagesFunction } from "@cloudflare/workers-types";
import { verifyPassword, generateToken, setAuthCookie } from "../../lib/auth";

interface Env {
  DB: D1Database;
  JWT_SECRET?: string;
  JWKS_KEY?: string;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  ENVIRONMENT?: string;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { env } = context;
  const db = (context.data as { db: ReturnType<typeof import("../../lib/db").createDb> }).db;

  let body: { username?: string; password?: string };
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ success: false, error: "请求格式错误" }, { status: 400 });
  }

  const { username, password } = body;
  if (!username || !password) {
    return Response.json({ success: false, error: "用户名和密码不能为空" }, { status: 400 });
  }

  // 从环境变量验证（不存储在数据库中比对，直接用环境变量）
  const envUsername = env.ADMIN_USERNAME;
  const envPassword = env.ADMIN_PASSWORD;

  if (!envUsername || !envPassword) {
    return Response.json({ success: false, error: "管理员账户未配置" }, { status: 500 });
  }

  if (username !== envUsername) {
    return Response.json({ success: false, error: "用户名或密码错误" }, { status: 401 });
  }

  // 验证密码 — 从 DB 读取密码哈希进行比对
  const { admins } = await import("../../lib/schema");
  const { eq } = await import("drizzle-orm");
  const admin = await db.select().from(admins).where(eq(admins.username, username)).get();

  if (!admin) {
    return Response.json({ success: false, error: "用户名或密码错误" }, { status: 401 });
  }

  const valid = await verifyPassword(password, admin.passwordHash);
  if (!valid) {
    return Response.json({ success: false, error: "用户名或密码错误" }, { status: 401 });
  }

  // 签发 JWT
  const token = await generateToken({ adminId: admin.id, username: admin.username }, env as never);
  setAuthCookie(context, token, env as never);

  return Response.json({ success: true, data: { username: admin.username } });
};
