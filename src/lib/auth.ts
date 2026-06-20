import jwt from "jsonwebtoken";
import { cookies } from "next/headers";
import { prisma } from "./prisma";
import { hashPassword, verifyPassword } from "./auth-helpers";

const TOKEN_EXPIRY = "7d";
const COOKIE_NAME = "admin_token";

/**
 * 获取 JWT 密钥，未配置时抛出错误
 */
function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET 环境变量未配置，无法生成或验证 Token");
  }
  return secret;
}

export interface AdminPayload {
  adminId: string;
  username: string;
}

/**
 * 生成 JWT Token
 */
export function generateToken(payload: AdminPayload): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: TOKEN_EXPIRY });
}

/**
 * 验证 JWT Token
 */
export function verifyToken(token: string): AdminPayload | null {
  try {
    return jwt.verify(token, getJwtSecret()) as AdminPayload;
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
    secure: process.env.NODE_ENV === "production",
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
