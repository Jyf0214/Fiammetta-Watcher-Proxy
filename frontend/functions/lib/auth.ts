/**
 * 管理员认证模块 — Pages Functions 专用
 *
 * 功能：
 * - JWT Token 生成与验证（jose 库，Edge Runtime 兼容）
 * - 密码哈希与验证（Web Crypto API PBKDF2）
 * - Cookie 管理
 * - 管理员自动初始化（从环境变量读取 ADMIN_USERNAME + ADMIN_PASSWORD）
 */

import { SignJWT, jwtVerify, importPKCS8, importSPKI, importJWK } from "jose";
import { type Context } from "hono";
import { createDb, type Database } from "./db";
import { admins } from "./schema";
import { eq } from "drizzle-orm";

// ==================== 常量 ====================

const TOKEN_EXPIRY = "7d";
const COOKIE_NAME = "admin_token";
const SALT_LENGTH = 16;
const HASH_ITERATIONS = 600000;
const KEY_LENGTH = 64;

// ==================== 类型 ====================

export interface AdminPayload {
  adminId: string;
  username: string;
}

interface Env {
  DB: D1Database;
  JWT_SECRET?: string;
  JWKS_KEY?: string;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  ENVIRONMENT?: string;
}

// ==================== 密码哈希（Web Crypto PBKDF2） ====================

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBuffer(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function constantTimeCompare(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length > 128) throw new Error("密码长度不能超过 128 个字符");

  const saltBytes = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const salt = bufferToHex(saltBytes.buffer);
  const passwordBuffer = new TextEncoder().encode(password);
  const saltBuffer = new TextEncoder().encode(salt);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    passwordBuffer.buffer as ArrayBuffer,
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );

  const hashBuffer = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBuffer.buffer as ArrayBuffer, iterations: HASH_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    KEY_LENGTH * 8
  );

  return `${salt}:${bufferToHex(hashBuffer)}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  try {
    if (password.length > 128) return false;
    const [salt, hash] = storedHash.split(":");
    if (!salt || !hash) return false;

    const passwordBuffer = new TextEncoder().encode(password);
    const saltBuffer = new TextEncoder().encode(salt);

    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      passwordBuffer.buffer as ArrayBuffer,
      { name: "PBKDF2" },
      false,
      ["deriveBits"]
    );

    const computedHashBuffer = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: saltBuffer.buffer as ArrayBuffer, iterations: HASH_ITERATIONS, hash: "SHA-256" },
      keyMaterial,
      KEY_LENGTH * 8
    );

    const computedHash = bufferToHex(computedHashBuffer);
    return constantTimeCompare(hexToBuffer(hash), hexToBuffer(computedHash));
  } catch {
    return false;
  }
}

// ==================== JWT 密钥格式识别 ====================

type JwtConfig =
  | { type: "hs256"; secret: string }
  | { type: "rs256"; privateKey: CryptoKey | Uint8Array | null; publicKey: CryptoKey | Uint8Array };

let cachedConfig: JwtConfig | null = null;

async function parseJwtConfig(env: Env): Promise<JwtConfig> {
  if (cachedConfig) return cachedConfig;

  const raw = env.JWKS_KEY || env.JWT_SECRET;
  if (!raw) throw new Error("JWKS_KEY 或 JWT_SECRET 未配置");

  const trimmed = raw.trim();

  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;

    if (Array.isArray(parsed.keys) && parsed.keys.length > 0) {
      const jwk = parsed.keys[0] as JsonWebKey;
      if (jwk.kty && jwk.d) {
        const privateKey = await importJWK(jwk, "RS256");
        const publicKeyJwk: JsonWebKey = { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", key_ops: ["verify"] };
        const publicKey = await importJWK(publicKeyJwk, "RS256");
        cachedConfig = { type: "rs256", privateKey, publicKey };
        return cachedConfig;
      }
    }

    if (typeof parsed.kty === "string" && typeof parsed.d === "string") {
      const jwk = parsed as unknown as JsonWebKey;
      const privateKey = await importJWK(jwk, "RS256");
      const publicKeyJwk: JsonWebKey = { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", key_ops: ["verify"] };
      const publicKey = await importJWK(publicKeyJwk, "RS256");
      cachedConfig = { type: "rs256", privateKey, publicKey };
      return cachedConfig;
    }
  }

  if (trimmed.includes("-----BEGIN") && trimmed.includes("PRIVATE KEY")) {
    const privateKey = await importPKCS8(trimmed, "RS256");
    cachedConfig = { type: "rs256", privateKey, publicKey: privateKey };
    return cachedConfig;
  }

  if (trimmed.includes("-----BEGIN") && trimmed.includes("PUBLIC KEY")) {
    const publicKey = await importSPKI(trimmed, "RS256");
    cachedConfig = { type: "rs256", privateKey: null, publicKey };
    return cachedConfig;
  }

  if (new TextEncoder().encode(trimmed).length < 32) {
    throw new Error("HS256 密钥长度不足：至少需要 32 字节");
  }
  cachedConfig = { type: "hs256", secret: trimmed };
  return cachedConfig;
}

// ==================== JWT 生成与验证 ====================

export async function generateToken(payload: AdminPayload, env: Env): Promise<string> {
  const config = await parseJwtConfig(env);
  const jwt = new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: config.type === "rs256" ? "RS256" : "HS256" })
    .setIssuedAt()
    .setExpirationTime(TOKEN_EXPIRY);

  if (config.type === "rs256") {
    if (!config.privateKey) throw new Error("仅配置了公钥，无法签名");
    return jwt.sign(config.privateKey);
  }
  return jwt.sign(new TextEncoder().encode(config.secret));
}

export async function verifyToken(token: string, env: Env): Promise<AdminPayload | null> {
  try {
    const config = await parseJwtConfig(env);
    if (config.type === "rs256") {
      const { payload } = await jwtVerify(token, config.publicKey, { algorithms: ["RS256"] });
      return payload as unknown as AdminPayload;
    }
    const { payload } = await jwtVerify(token, new TextEncoder().encode(config.secret), { algorithms: ["HS256"] });
    return payload as unknown as AdminPayload;
  } catch {
    return null;
  }
}

// ==================== Cookie 管理 ====================

function parseCookie(cookieHeader: string | undefined | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const cookie of cookieHeader.split(";")) {
    const [key, ...rest] = cookie.trim().split("=");
    if (key === name) return rest.join("=").trim();
  }
  return null;
}

export function setAuthCookie(c: Context, token: string, env: Env): void {
  const isProd = env.ENVIRONMENT === "production";
  const parts = [`${COOKIE_NAME}=${token}`, "HttpOnly", "SameSite=Lax", `Max-Age=${7 * 24 * 60 * 60}`, "Path=/"];
  if (isProd) parts.push("Secure");
  c.header("Set-Cookie", parts.join("; "));
}

export function clearAuthCookie(c: Context): void {
  c.header("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; Max-Age=0; Path=/`);
}

export function getAdminFromCookie(c: Context, env: Env): Promise<AdminPayload | null> {
  const token = parseCookie(c.req.header("cookie"), COOKIE_NAME);
  if (!token) return Promise.resolve(null);
  return verifyToken(token, env);
}

// ==================== 管理员自动初始化 ====================

let initialized = false;

/**
 * 从环境变量读取 ADMIN_USERNAME + ADMIN_PASSWORD，自动创建管理员账户。
 * 仅在 admins 表为空时执行，不设置任何默认值。
 */
export async function ensureAdmin(db: Database, env: Env): Promise<void> {
  if (initialized) return;

  const existing = await db.select().from(admins).limit(1).get();
  if (existing) {
    initialized = true;
    return;
  }

  const username = env.ADMIN_USERNAME;
  const password = env.ADMIN_PASSWORD;
  if (!username || !password) {
    console.warn("[auth] ADMIN_USERNAME 或 ADMIN_PASSWORD 未配置，跳过管理员初始化");
    return;
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const passwordHash = await hashPassword(password);

  await db.insert(admins).values({ id, username, passwordHash, createdAt: now, updatedAt: now }).run();
  console.log(`[auth] 管理员 "${username}" 已从环境变量初始化`);
  initialized = true;
}
