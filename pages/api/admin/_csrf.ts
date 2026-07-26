/**
 * CSRF 防护模块（Double-Submit Cookie 模式）
 *
 * 原理：
 * - 登录时生成随机 CSRF token，同时存入：
 *   1. 非 HttpOnly cookie（前端 JS 可读取，放入 X-CSRF-Token 请求头）
 *   2. JWT payload 的 csrf 字段（后端从 HttpOnly cookie 中的 JWT 解析）
 * - 验证时比对请求头中的 X-CSRF-Token 与 JWT 中的 csrf 是否一致
 *
 * 安全性：
 * - 跨站请求无法读取 cookie（SameSite=Lax）或注入请求头
 * - CSP frame-ancestors 'self' 防止点击劫持
 * - 即使 SameSite 被绕过，攻击者也无法获取 cookie 值来设置请求头
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { verifyToken } from "@/lib/auth";
import { getTokenFromCookie } from "./_auth";

/** CSRF cookie 名称 */
export const CSRF_COOKIE_NAME = "csrf_token";

/** CSRF token 长度（字节），编码后约 43 字符 */
const CSRF_TOKEN_BYTES = 32;

/**
 * 生成 CSRF token（密码学安全随机字符串）
 */
export function generateCsrfToken(): string {
  const array = new Uint8Array(CSRF_TOKEN_BYTES);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array)).replace(/[+/=]/g, (c) =>
    c === "+" ? "-" : c === "/" ? "_" : ""
  );
}

/**
 * 设置 CSRF cookie（非 HttpOnly，前端 JS 可读取）
 */
export function setCsrfCookie(
  res: NextApiResponse,
  token: string,
  isProd: boolean
): void {
  const cookie = [
    `${CSRF_COOKIE_NAME}=${token}`,
    "Path=/",
    "SameSite=Strict",
    `Max-Age=${7 * 24 * 60 * 60}`,
    isProd ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
  res.setHeader("Set-Cookie", cookie);
}

/**
 * 清除 CSRF cookie
 */
export function clearCsrfCookie(res: NextApiResponse): void {
  const cookie = [
    `${CSRF_COOKIE_NAME}=`,
    "Path=/",
    "SameSite=Strict",
    "Max-Age=0",
  ].join("; ");
  res.setHeader("Set-Cookie", cookie);
}

/**
 * 验证 CSRF token（从请求头 X-CSRF-Token 与 JWT payload 中的 csrf 比对）
 *
 * 返回 true 表示验证通过，false 表示拒绝
 */
export async function validateCsrfRequest(
  req: NextApiRequest,
  res: NextApiResponse
): Promise<boolean> {
  // 1. 从请求头获取 CSRF token
  const headerToken = req.headers["x-csrf-token"];
  if (!headerToken || typeof headerToken !== "string") {
    res.status(403).json({ success: false, error: "缺少 CSRF token" });
    return false;
  }

  // 2. 从 JWT 中获取 csrf 字段
  const token = getTokenFromCookie(req);
  if (!token) {
    res.status(401).json({ success: false, error: "未授权" });
    return false;
  }

  try {
    const payload = await verifyToken(token, {
      JWT_SECRET: process.env.JWT_SECRET,
    });
    const payloadRecord = payload as unknown as Record<string, unknown>;
    if (!payloadRecord.csrf) {
      res.status(403).json({ success: false, error: "JWT 中缺少 CSRF 信息" });
      return false;
    }

    const jwtCsrf = payloadRecord.csrf as string;

    // 3. 恒定时间比较，防止时序攻击
    if (headerToken.length !== jwtCsrf.length) {
      res.status(403).json({ success: false, error: "CSRF token 无效" });
      return false;
    }

    let mismatch = 0;
    for (let i = 0; i < headerToken.length; i++) {
      mismatch |= headerToken.charCodeAt(i) ^ jwtCsrf.charCodeAt(i);
    }

    if (mismatch !== 0) {
      res.status(403).json({ success: false, error: "CSRF token 无效" });
      return false;
    }

    return true;
  } catch {
    res.status(403).json({ success: false, error: "CSRF 验证失败" });
    return false;
  }
}

/**
 * CSRF 中间件：对 state-changing 请求（POST/PUT/DELETE/PATCH）强制验证
 * GET/HEAD/OPTIONS 请求跳过验证
 */
export async function requireCsrf(
  req: NextApiRequest,
  res: NextApiResponse
): Promise<boolean> {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method || "")) {
    return true;
  }
  return validateCsrfRequest(req, res);
}

// Next.js 16 类型检查器将 pages/api/ 下所有文件视为路由，工具模块导出空 handler 避免误报
export default function _noop() {}
