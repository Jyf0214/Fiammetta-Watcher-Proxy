/**
 * GET /api/admin/auth — 获取当前管理员信息
 */

import { type PagesFunction } from "@cloudflare/workers-types";

interface Env {
  DB: D1Database;
  JWT_SECRET?: string;
  JWKS_KEY?: string;
  ENVIRONMENT?: string;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const admin = (context.data as { admin: { adminId: string; username: string } }).admin;
  return Response.json({ success: true, data: { username: admin.username } });
};
