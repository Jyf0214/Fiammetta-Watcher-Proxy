/**
 * 中间件 — Admin 页面认证保护 + 安全头 + 速率限制
 *
 * 功能：
 * - /admin/* 页面路由认证保护（排除登录页）
 * - /api/admin/* 路由统一鉴权兜底（排除登录接口）
 * - /api/admin/* 路由 IP 级速率限制（60 次/分钟/IP）
 * - /api/v1/* 路由 CORS 处理
 * - 安全响应头注入
 *
 * 注意：
 * - Edge Runtime 不支持完整 JWT 签名验证（jose 需要异步），
 *   此中间件仅做轻量级 JWT 过期检查（Base64 解码 payload），
 *   完整签名验证在各路由处理器中通过 getAdminFromRequest 进行。
 * - 每个 /api/admin/* 路由处理器必须调用 getAdminFromRequest 进行完整验证。
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";


// ==================== Admin API 速率限制 (60 次/分钟/IP) ====================
// Edge Runtime 中使用全局变量 Map 实现，不依赖 Node.js API

const adminRateLimit = new Map<string, { count: number; resetAt: number }>();
const ADMIN_RATE_LIMIT = 60;
const ADMIN_RATE_WINDOW = 60_000;

/**
 * 惰性清理过期条目
 * 每次请求时顺带执行，避免依赖 setInterval（Edge Runtime 限制）
 */
function cleanupAdminRateLimit() {
  const now = Date.now();
  for (const [key, entry] of adminRateLimit) {
    if (now > entry.resetAt) adminRateLimit.delete(key);
  }
}

/**
 * 检查 IP 是否超出 admin API 速率限制
 * 返回 true 表示允许，false 表示超出限制
 */
function checkAdminRateLimit(ip: string): boolean {
  const now = Date.now();
  // 惰性清理过期条目，避免内存积累
  cleanupAdminRateLimit();

  const entry = adminRateLimit.get(ip);
  if (!entry || now > entry.resetAt) {
    adminRateLimit.set(ip, { count: 1, resetAt: now + ADMIN_RATE_WINDOW });
    return true;
  }
  if (entry.count >= ADMIN_RATE_LIMIT) {
    return false;
  }
  entry.count++;
  return true;
}

// ==================== JWT 过期检查（轻量级） ====================

/**
 * Base64URL 解码辅助函数，兼容 JWT 标准中的 Base64URL 编码（- 和 _）
 */
function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  return atob(base64);
}

/**
 * 从 JWT token 中提取 payload 并检查是否过期
 * 注意：此函数不验证签名，仅做快速过期检查
 * @returns payload 对象或 null（解析失败/已过期）
 */
function checkJwtExpiry(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const payload = JSON.parse(base64UrlDecode(parts[1]));
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      return null; // 已过期
    }
    return payload;
  } catch {
    return null; // 格式无效
  }
}

// ==================== 安全响应头 ====================

/**
 * 注入安全响应头
 * - X-Content-Type-Options: nosniff（防止 MIME 嗅探）
 * - X-Frame-Options: DENY（防止点击劫持）
 * - Referrer-Policy: strict-origin-when-cross-origin
 * - X-XSS-Protection: 0（现代浏览器已弃用，设为 0 避免旧版 XSS 过滤器的副作用）
 */
function setSecurityHeaders(response: Response): Response {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-XSS-Protection", "0");
  return response;
}

// ==================== 客户端 IP 提取 ====================

function getClientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

// ==================== 中间件主逻辑 ====================

/**
 * Proxy 安全中间件
 *
 * 路由规则：
 * - /admin/* 页面路由 → Cookie 认证检查
 * - /api/admin/* 路由 → Cookie 认证兜底 + 速率限制
 * - /api/v1/* 路由 → CORS 处理
 * - 所有路由 → 安全响应头注入
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const response = NextResponse.next();

  // ==================== /admin/* 页面路由认证保护 ====================
  // 保护所有 admin 页面，排除登录页和静态资源
  if (pathname.startsWith("/admin") && !pathname.startsWith("/admin/login")) {
    // 检查是否为静态资源（CSS、JS、图片等）
    const isStaticResource =
      /\.(css|js|ico|png|jpg|jpeg|gif|svg|woff|woff2|ttf|eot)$/i.test(
        pathname
      );

    if (!isStaticResource) {
      const token = request.cookies.get("admin_token")?.value;
      if (!token) {
        // 未登录，重定向到登录页
        const loginUrl = new URL("/admin/login", request.url);
        loginUrl.searchParams.set("from", pathname);
        return NextResponse.redirect(loginUrl);
      }

      // 轻量级 JWT 过期检查
      const payload = checkJwtExpiry(token);
      if (!payload) {
        // Token 格式无效或已过期，重定向到登录页
        const loginUrl = new URL("/admin/login", request.url);
        loginUrl.searchParams.set("from", pathname);
        loginUrl.searchParams.set("expired", "1");
        return NextResponse.redirect(loginUrl);
      }
    }
  }

  // ==================== /api/admin/* 鉴权兜底 ====================
  if (pathname.startsWith("/api/admin/")) {
    // 公开路径：登录接口、配置检查接口
    const publicPaths = ["/api/admin/auth", "/api/admin/login"];
    const isPublic = publicPaths.some(
      (p) => pathname === p || pathname.startsWith(p + "/")
    );

    if (!isPublic) {
      // Cookie 名称与 auth.ts 中设置的 admin_token 保持一致
      const token = request.cookies.get("admin_token")?.value;
      if (!token) {
        return NextResponse.json(
          { success: false, error: "未授权：请先登录" },
          { status: 401 }
        );
      }

      // 轻量级 JWT 过期检查
      // 【安全依赖】：每个 /api/admin/* 路由处理器必须调用 getAdminFromRequest()
      // 进行完整签名验证，此中间件仅作为第一道防线
      const payload = checkJwtExpiry(token);
      if (!payload) {
        return NextResponse.json(
          { success: false, error: "登录已过期" },
          { status: 401 }
        );
      }

      // JWT 有效，执行 IP 级速率限制检查
      const clientIp = getClientIp(request);
      if (!checkAdminRateLimit(clientIp)) {
        return NextResponse.json(
          { success: false, error: "请求过于频繁，请稍后再试" },
          { status: 429 }
        );
      }
    }
  }

  // ==================== /api/setup/* 速率限制 ====================
  if (pathname.startsWith("/api/setup/")) {
    const clientIp = getClientIp(request);
    if (!checkAdminRateLimit(clientIp)) {
      return NextResponse.json(
        { success: false, error: "请求过于频繁，请稍后再试" },
        { status: 429 }
      );
    }
  }

  // ==================== /api/v1/* CORS ====================
  if (pathname.startsWith("/api/v1/")) {
    if (request.method === "OPTIONS") {
      return new NextResponse(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
    response.headers.set("Access-Control-Allow-Origin", "*");
    response.headers.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization"
    );
  }

  // ==================== 安全响应头 ====================
  setSecurityHeaders(response);

  return response;
}

// ==================== Next.js 中间件配置 ====================
// matcher 决定哪些路径会经过此中间件

export const config = {
  matcher: [
    "/api/:path*",
    // Admin 页面路由保护（排除登录页和静态资源）
    "/admin/:path*",
  ],
};
