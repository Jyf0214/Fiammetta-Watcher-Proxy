/**
 * JWT 认证核心模块
 *
 * - JWT 签名/验证：使用 jose 库（Web Crypto API 兼容，Edge Runtime 可用）
 * - 仅支持 HS256（Cloudflare 不支持 RS256）
 */

import { SignJWT, jwtVerify } from "jose";

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
/** JWT_SECRET 最小长度（防止弱密钥被暴力破解） */
const MIN_JWT_SECRET_LENGTH = 32;

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

  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET 强度不足：至少需要 ${MIN_JWT_SECRET_LENGTH} 个字符（当前 ${secret.length} 个）`
    );
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

// ==================== 导出 ====================

export { COOKIE_NAME };
