/**
 * Pages Functions 全局中间件
 *
 * 处理：
 * - CORS（Admin API）
 * - 管理员认证检查（除登录接口外所有 /api/admin/* 需要 JWT）
 * - 管理员自动初始化（首次访问时从环境变量创建）
 * - 管理 API 速率限制（KV）
 */

import { createDb } from "./lib/db";
import { ensureAdmin, getAdminFromCookie } from "./lib/auth";

interface Env {
  DB: D1Database;
  KV: KVNamespace;
  JWT_SECRET?: string;
  JWKS_KEY?: string;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  ENVIRONMENT?: string;
}

// 不需要认证的路径
const PUBLIC_PATHS = ["/api/admin/auth"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname === p + "/");
}

async function checkAdminRateLimit(kv: KVNamespace, ip: string): Promise<boolean> {
  const key = `admin_rate:${ip}`;
  try {
    const raw = await kv.get(key);
    const count = raw ? parseInt(raw, 10) + 1 : 1;
    await kv.put(key, String(count), { expirationTtl: 60 });
    return count <= 60;
  } catch {
    return true;
  }
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const pathname = url.pathname;

  // CORS 预检
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // 非 admin 路径直接放行
  if (!pathname.startsWith("/api/admin/")) {
    return next();
  }

  // 管理 API 速率限制
  const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip") || "unknown";
  if (env.KV && !(await checkAdminRateLimit(env.KV, clientIp))) {
    return Response.json({ success: false, error: "请求过于频繁" }, { status: 429 });
  }

  // 确保管理员已初始化（从环境变量）
  const db = createDb(env.DB);
  await ensureAdmin(db, env);

  // 登录接口不需要认证
  if (isPublicPath(pathname)) {
    context.data.db = db;
    return next();
  }

  // 验证管理员认证
  const admin = await getAdminFromCookie(context, env);
  if (!admin) {
    return Response.json({ success: false, error: "未登录或登录已过期" }, { status: 401 });
  }

  // 将 admin 信息和 db 实例传递给路由处理器
  context.data.admin = admin;
  context.data.db = db;
  return next();
};
