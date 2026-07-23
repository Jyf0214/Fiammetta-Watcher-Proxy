/**
 * JWT 认证核心模块
 *
 * - JWT 签名/验证：使用 jose 库（Web Crypto API 兼容，Edge Runtime 可用）
 * - 仅支持 HS256（Cloudflare 不支持 RS256）
 * - Cookie 管理：设置/清除 admin_token
 * - 管理员身份提取：从 Cookie 中解析 JWT 并查询 D1 验证
 */

import { SignJWT, jwtVerify } from "jose";
import { createDb } from "./prisma";

// ==================== 常量 ====================

/** JWT 有效期 7 天 */
const TOKEN_EXPIRY = "7d";

/** Cookie 名称，与 main 分支保持一致 */
const COOKIE_NAME = "admin_token";

// ==================== 类型 ====================

/** JWT Payload 结构 */
export interface AdminPayload {
  adminId: string;
  username: string;
}

// ==================== 环境变量检查 ====================

/**
 * 解析 JWT_SECRET 参数
 *
 * 支持多种调用方式（兼容其他 Agent 的不同调用模式）：
 * - verifyToken(token) → 从全局 JWT_SECRET 获取
 * - verifyToken(token, "secret-string") → 直接传入密钥
 * - verifyToken(token, { JWT_SECRET: "..." }) → 传入 env 对象
 */
function resolveJwtSecret(
  secretOrEnv?: string | { JWT_SECRET?: string }
): Uint8Array {
  let secret: string | undefined;

  if (typeof secretOrEnv === "string") {
    secret = secretOrEnv;
  } else if (secretOrEnv && typeof secretOrEnv === "object") {
    secret = secretOrEnv.JWT_SECRET;
  } else {
    // 未传参数时尝试从全局变量获取
    // Cloudflare Pages Functions 的 middleware 可将 env.JWT_SECRET 存入 globalThis
    secret = (globalThis as Record<string, unknown>).JWT_SECRET as string | undefined;
  }

  if (!secret) {
    throw new Error("JWT_SECRET 环境变量未配置，无法生成或验证 Token");
  }
  return new TextEncoder().encode(secret);
}

// ==================== JWT 生成/验证 ====================

/**
 * 生成 JWT Token（HS256 签名）
 *
 * @param payload - 要签入 Token 的数据（adminId, username）
 * @param env - 包含 JWT_SECRET 的环境变量（字符串或对象均可）
 * @returns JWT 字符串
 */
export async function generateToken(
  payload: AdminPayload,
  secretOrEnv?: string | { JWT_SECRET?: string }
): Promise<string> {
  const secret = resolveJwtSecret(secretOrEnv);

  return new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(TOKEN_EXPIRY)
    .sign(secret);
}

/**
 * 验证 JWT Token（HS256 验证）
 *
 * 支持多种调用方式：
 * - verifyToken(token, env) — env 对象
 * - verifyToken(token, "secret") — 直接传入密钥字符串
 *
 * @param token - JWT 字符串
 * @param secretOrEnv - 密钥字符串或包含 JWT_SECRET 的对象
 * @returns 解码后的 payload，验证失败返回 null
 */
export async function verifyToken(
  token: string,
  secretOrEnv?: string | { JWT_SECRET?: string }
): Promise<AdminPayload | null> {
  try {
    const secret = resolveJwtSecret(secretOrEnv);
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
    });

    return payload as unknown as AdminPayload;
  } catch {
    // Token 验证失败（过期、签名无效等），返回 null 表示未认证
    return null;
  }
}

// ==================== Cookie 操作 ====================

/**
 * 设置登录 Cookie（httpOnly + secure + SameSite=Lax）
 *
 * @param response - 当前 Response 对象
 * @param token - JWT Token
 * @param isProd - 是否为生产环境（控制 Secure 标志）
 */
export function setAuthCookie(
  response: Response,
  token: string,
  isProd: boolean
): Response {
  const cookie = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    `SameSite=Lax`,
    `Max-Age=${7 * 24 * 60 * 60}`, // 7 天
    isProd ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");

  // 使用 clone() 避免修改已发送的 Response
  const newResponse = new Response(response.body, response);
  newResponse.headers.append("Set-Cookie", cookie);
  return newResponse;
}

/**
 * 清除登录 Cookie
 *
 * @param response - 当前 Response 对象
 */
export function clearAuthCookie(response: Response): Response {
  const cookie = [
    `${COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ].join("; ");

  const newResponse = new Response(response.body, response);
  newResponse.headers.append("Set-Cookie", cookie);
  return newResponse;
}

/**
 * 从请求 Cookie 中提取 admin_token
 *
 * @param request - 传入的 Request
 * @returns token 字符串，不存在则返回 null
 */
export function getTokenFromCookie(request: Request): string | null {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;

  // 解析 Cookie，查找 admin_token
  const cookies = cookieHeader.split(";");
  for (const cookie of cookies) {
    const [name, ...rest] = cookie.trim().split("=");
    if (name === COOKIE_NAME) {
      return rest.join("="); // 值中可能包含 = 号
    }
  }
  return null;
}

// ==================== 管理员身份验证 ====================

/**
 * 从请求中提取管理员身份
 *
 * 流程：
 * 1. 从 Cookie 中获取 JWT Token
 * 2. 验证 JWT 签名和有效期
 * 3. 查询 D1 数据库确认管理员仍存在
 *
 * @param request - 传入的 Request
 * @param env - 包含 JWT_SECRET 和 DB 的环境变量
 * @returns 管理员 payload，未认证返回 null
 */
export async function getAdminFromRequest(
  request: Request,
  env: { JWT_SECRET?: string; DB: D1Database }
): Promise<AdminPayload | null> {
  const token = getTokenFromCookie(request);
  if (!token) return null;

  const payload = await verifyToken(token, env);
  if (!payload) return null;

  // 验证管理员是否仍然存在于数据库中
  try {
    const prisma = await createDb();
    const admin = await prisma.admins.findFirst({
      where: { id: payload.adminId },
      select: { id: true },
    });

    if (!admin) return null;
  } catch {
    // 数据库查询失败，视为未认证
    return null;
  }

  return payload;
}

// ==================== 导出 ====================

export { COOKIE_NAME };
export { hashPassword, verifyPassword } from "./auth-helpers";
