import jwt from "jsonwebtoken";
import { createPrivateKey, createPublicKey } from "crypto";
import { cookies } from "next/headers";
import { prisma } from "./prisma";
import { hashPassword, verifyPassword } from "./auth-helpers";

const TOKEN_EXPIRY = "7d";
const COOKIE_NAME = "admin_token";

export interface AdminPayload {
  adminId: string;
  username: string;
}

// ---------- JWT 密钥格式识别 ----------

interface Hs256Config {
  type: "hs256";
  secret: string;
}

interface Rs256Config {
  type: "rs256";
  privateKey: ReturnType<typeof createPrivateKey>;
  publicKey: ReturnType<typeof createPublicKey>;
}

type JwtConfig = Hs256Config | Rs256Config;

let cachedConfig: JwtConfig | null = null;

/**
 * 解析 JWKS_KEY / JWT_SECRET，自动识别密钥格式：
 * - JWKS JSON → RS256
 * - 单个 JWK JSON → RS256
 * - PEM 私钥 → RS256
 * - 其他字符串 → HS256
 */
function parseJwtConfig(): JwtConfig {
  if (cachedConfig) return cachedConfig;

  const raw = process.env.JWKS_KEY || process.env.JWT_SECRET;
  if (!raw) {
    throw new Error("JWKS_KEY 或 JWT_SECRET 环境变量均未配置，无法生成或验证 Token");
  }

  const trimmed = raw.trim();

  // 尝试解析为 JSON
  if (trimmed.startsWith("{")) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("JWKS_KEY/JWT_SECRET 是无效的 JSON 格式");
    }

    // JWKS 格式：{ keys: [...] }
    if (Array.isArray(parsed.keys) && parsed.keys.length > 0) {
      const jwk = parsed.keys[0] as Record<string, unknown>;
      if (typeof jwk.kty === "string" && typeof jwk.d === "string") {
        try {
          const privateKey = createPrivateKey({ key: jwk as Record<string, unknown> as never, format: "jwk" });
          const publicKey = createPublicKey(privateKey);
          cachedConfig = { type: "rs256", privateKey, publicKey };
          console.log("[auth] JWT 模式: RS256 (JWKS)");
          return cachedConfig;
        } catch (e) {
          throw new Error(`JWKS 私钥解析失败: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      throw new Error("JWKS 中的密钥缺少 kty 或 d 字段（需要包含私钥）");
    }

    // 单个 JWK 格式：{ kty: "...", d: "..." }
    if (typeof parsed.kty === "string" && typeof parsed.d === "string") {
      try {
        const privateKey = createPrivateKey({ key: parsed as Record<string, unknown> as never, format: "jwk" });
        const publicKey = createPublicKey(privateKey);
        cachedConfig = { type: "rs256", privateKey, publicKey };
        console.log("[auth] JWT 模式: RS256 (JWK)");
        return cachedConfig;
      } catch (e) {
        throw new Error(`JWK 私钥解析失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    throw new Error(
      "JWKS_KEY/JWT_SECRET 是 JSON 格式但不是有效的 JWK 或 JWKS"
    );
  }

  // PEM 格式：-----BEGIN ... PRIVATE KEY-----
  if (trimmed.includes("-----BEGIN") && trimmed.includes("PRIVATE KEY")) {
    try {
      const privateKey = createPrivateKey(trimmed);
      const publicKey = createPublicKey(privateKey);
      cachedConfig = { type: "rs256", privateKey, publicKey };
      console.log("[auth] JWT 模式: RS256 (PEM)");
      return cachedConfig;
    } catch (e) {
      throw new Error(`PEM 私钥解析失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 默认：HS256 对称密钥
  cachedConfig = { type: "hs256", secret: trimmed };
  console.log("[auth] JWT 模式: HS256");
  return cachedConfig;
}

/**
 * 生成 JWT Token（RS256 用私钥签名）
 */
export function generateToken(payload: AdminPayload): string {
  const config = parseJwtConfig();

  if (config.type === "rs256") {
    return jwt.sign(payload, config.privateKey, {
      algorithm: "RS256",
      expiresIn: TOKEN_EXPIRY,
    });
  }

  return jwt.sign(payload, config.secret, { expiresIn: TOKEN_EXPIRY });
}

/**
 * 验证 JWT Token（RS256 用公钥验证）
 */
export function verifyToken(token: string): AdminPayload | null {
  try {
    const config = parseJwtConfig();

    if (config.type === "rs256") {
      return jwt.verify(token, config.publicKey, {
        algorithms: ["RS256"],
      }) as AdminPayload;
    }

    return jwt.verify(token, config.secret) as AdminPayload;
  } catch {
    return null;
  }
}

/**
 * 从请求中提取管理员身份
 */
export async function getAdminFromRequest(): Promise<AdminPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;

  if (!token) return null;

  const payload = verifyToken(token);
  if (!payload) return null;

  // 验证管理员是否仍然存在
  const admin = await prisma.admin.findUnique({
    where: { id: payload.adminId },
  });

  if (!admin) return null;

  return payload;
}

/**
 * 设置登录 Cookie
 */
export async function setAuthCookie(token: string) {
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: false,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60, // 7 天
    path: "/",
  });
}

/**
 * 清除登录 Cookie
 */
export async function clearAuthCookie() {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}

export { hashPassword, verifyPassword };
