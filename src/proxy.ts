import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// ==================== Admin API 速率限制 (60次/分钟/IP) ====================
// Edge Runtime 中使用全局变量 Map 实现，不依赖 Node.js API
const adminRateLimit = new Map<string, { count: number; resetAt: number }>();
const ADMIN_RATE_LIMIT = 60;
const ADMIN_RATE_WINDOW = 60_000;

/**
 * 检查 IP 是否超出 admin API 速率限制
 * 返回 true 表示允许，false 表示超出限制
 */
function checkAdminRateLimit(ip: string): boolean {
  const now = Date.now();
  // 先清理过期条目，避免延迟清理导致的内存积累
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

/**
 * 惰性清理过期条目，每次请求时顺带执行，避免依赖 setInterval（Edge Runtime 限制）
 */
function cleanupAdminRateLimit() {
  const now = Date.now();
  for (const [key, entry] of adminRateLimit) {
    if (now > entry.resetAt) adminRateLimit.delete(key);
  }
}

/**
 * Base64URL 解码辅助函数，兼容 JWT 标准中的 Base64URL 编码（- 和 _）
 */
function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  return atob(base64);
}

/**
 * Proxy 安全中间件 — Next.js 16 proxy.ts 规范
 * - /admin/* 页面路由认证保护（排除登录页）
 * - /api/admin/* 路由统一鉴权兜底（排除登录接口）
 * - /api/admin/* 路由 IP 级速率限制
 * - /api/v1/* 路由 CORS 处理
 * - 安全响应头注入
 * - 数据库配置检查：未配置时引导到 /setup 页面
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const response = NextResponse.next();

  // ==================== 数据库配置检查 ====================
  // 如果没有数据库环境变量，且访问的不是 /setup 路由，则重定向到 /setup
  // 优先级：远程环境变量 > 本地 .env 文件配置
  if (!pathname.startsWith("/setup")) {
    // 检查远程环境变量（优先级更高）
    const hasRemoteDatabaseUrl = !!request.headers.get("x-database-url");
    const hasLocalDatabaseUrl = !!process.env.DATABASE_URL;

    // 如果远程和本地都没有数据库 URL，则重定向到 /setup
    if (!hasRemoteDatabaseUrl && !hasLocalDatabaseUrl) {
      const setupUrl = new URL("/setup", request.url);
      setupUrl.searchParams.set("from", pathname);
      return NextResponse.redirect(setupUrl);
    }

    // 如果有远程环境变量，优先使用远程配置
    if (hasRemoteDatabaseUrl) {
      process.env.DATABASE_URL = request.headers.get("x-database-url")!;
    }
  }

  // ==================== /admin/* 页面路由认证保护 ====================
  // 保护所有 admin 页面，排除登录页和静态资源
  if (pathname.startsWith("/admin") && !pathname.startsWith("/admin/login")) {
    // 检查是否为静态资源（CSS、JS、图片等）
    const isStaticResource = /\.(css|js|ico|png|jpg|jpeg|gif|svg|woff|woff2|ttf|eot)$/i.test(pathname);

    if (!isStaticResource) {
      const token = request.cookies.get("admin_token")?.value;
      if (!token) {
        // 未登录，重定向到登录页
        const loginUrl = new URL("/admin/login", request.url);
        loginUrl.searchParams.set("from", pathname);
        return NextResponse.redirect(loginUrl);
      }

      // 轻量级 JWT 过期检查
      try {
        const payload = JSON.parse(base64UrlDecode(token.split(".")[1]));
        if (payload.exp && payload.exp * 1000 < Date.now()) {
          const loginUrl = new URL("/admin/login", request.url);
          loginUrl.searchParams.set("from", pathname);
          loginUrl.searchParams.set("expired", "1");
          return NextResponse.redirect(loginUrl);
        }
      } catch {
        // token 格式无效，重定向到登录页
        const loginUrl = new URL("/admin/login", request.url);
        loginUrl.searchParams.set("from", pathname);
        return NextResponse.redirect(loginUrl);
      }
    }
  }

  // 安全响应头统一由 next.config.ts 的 headers() 管理，proxy 中间件不再重复设置
  // 避免两处维护不一致

  // ==================== /api/admin/* 鉴权兜底 ====================
  if (pathname.startsWith("/api/admin/")) {
    const publicPaths = ["/api/admin/auth"];
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

      // Edge Runtime 无法使用 jsonwebtoken（依赖 Node.js API），
      // 此处仅做轻量级 JWT 过期检查，完整签名验证在路由处理器的 getAdminFromRequest 中进行。
      // 【安全依赖】：每个 /api/admin/* 路由处理器必须调用 getAdminFromRequest() 进行完整签名验证，
      // 此中间件仅作为第一道防线（快速拒绝明显过期的 token），不能替代签名验证。
      try {
        const payload = JSON.parse(base64UrlDecode(token.split(".")[1]));
        if (payload.exp && payload.exp * 1000 < Date.now()) {
          return NextResponse.json(
            { success: false, error: "登录已过期" },
            { status: 401 }
          );
        }
      } catch {
        return NextResponse.json(
          { success: false, error: "无效的认证凭证" },
          { status: 401 }
        );
      }

      // JWT 验证通过后，执行 IP 级速率限制检查
      const clientIp =
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        request.headers.get("x-real-ip") ||
        "unknown";
      // 先检查速率限制，再清理过期条目，防止清理后立即创建新条目绕过限制
      if (!checkAdminRateLimit(clientIp)) {
        return NextResponse.json(
          { success: false, error: "请求过于频繁，请稍后再试" },
          { status: 429 }
        );
      }
    }
  }

  // ==================== /api/v1/* CORS ====================
  // v1 路由使用 Bearer Token 认证，不依赖 Cookie，通配符 Origin 是合理的
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

  return response;
}

export const config = {
  matcher: [
    "/api/:path*",
    // Admin 页面路由保护（排除登录页和静态资源）
    "/admin/:path*",
  ],
};
