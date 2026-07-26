/**
 * 认证 API — 登录 / 登出 / 获取当前管理员信息
 *
 * POST   /api/admin/auth  — 管理员登录（验证用户名密码 → 生成 JWT → 设置 Cookie）
 * DELETE /api/admin/auth  — 管理员登出（清除 Cookie + 审计日志）
 * GET    /api/admin/auth  — 获取当前登录管理员信息
 *
 * 主分支对应文件：src/app/api/admin/auth/route.ts
 * Pages Router 格式转换
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { generateToken, verifyToken, type AdminPayload } from "@/lib/auth";
import { createDb } from "@/lib/prisma";
import { getAuditAdminId, type AuthResult } from "./_auth";

const COOKIE_NAME = "admin_token";

// ==================== 速率限制（KV 持久化滑动窗口） ====================

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 30 * 60 * 1000;
const KV_KEY_PREFIX = "login:fail:";

/**
 * KV 存储的失败记录结构
 * failures: 每次失败的时间戳（毫秒），用于滑动窗口
 * 每次失败追加新时间戳，检查时过滤掉超过 30 分钟的旧记录
 */
interface KVFails { failures: number[]; }

function kvKey(ip: string): string { return `${KV_KEY_PREFIX}${ip}`; }

/** 从 KV 读取失败记录，自动过滤过期 */
async function getRecentFails(kv: KVNamespace, ip: string): Promise<number[]> {
  const raw = await kv.get(kvKey(ip));
  if (!raw) return [];
  const data = JSON.parse(raw) as KVFails;
  const now = Date.now();
  return (data.failures || []).filter((ts) => now - ts < LOGIN_WINDOW_MS);
}

/** 写入失败记录到 KV */
async function saveFails(kv: KVNamespace, ip: string, failures: number[]): Promise<void> {
  if (failures.length === 0) {
    await kv.delete(kvKey(ip));
  } else {
    // KV TTL 设为窗口时间，到期自动清除
    await kv.put(kvKey(ip), JSON.stringify({ failures }), {
      expirationTtl: Math.ceil(LOGIN_WINDOW_MS / 1000) + 60,
    });
  }
}

// ==================== 工具函数 ====================

function getClientIp(req: NextApiRequest): string {
  const forwarded = req.headers["x-forwarded-for"];
  const str = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return str?.split(",")[0]?.trim() || (req.headers["x-real-ip"] as string) || "unknown";
}

function getTokenFromCookie(req: NextApiRequest): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  for (const cookie of cookieHeader.split(";")) {
    const [name, ...rest] = cookie.trim().split("=");
    if (name === COOKIE_NAME) return rest.join("=");
  }
  return null;
}

function setAuthCookie(res: NextApiResponse, token: string, isProd: boolean): void {
  const cookie = [`${COOKIE_NAME}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax",
    `Max-Age=${7 * 24 * 60 * 60}`, isProd ? "Secure" : ""].filter(Boolean).join("; ");
  res.setHeader("Set-Cookie", cookie);
}

function clearAuthCookie(res: NextApiResponse): void {
  const cookie = [`${COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"].join("; ");
  res.setHeader("Set-Cookie", cookie);
}

async function getAdmin(req: NextApiRequest, env: { JWT_SECRET?: string }): Promise<AdminPayload | null> {
  const token = getTokenFromCookie(req);
  if (!token) return null;
  const payload = await verifyToken(token, env);
  if (!payload) return null;
  return payload;
}

// ==================== Handler ====================

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  let kv: KVNamespace | undefined;
  try {
    const { env } = getCloudflareContext();
    kv = env.KV;
  } catch { /* 本地开发或非 CF 环境下 getCloudflareContext 可能抛异常 */ }

  switch (req.method) {
    case "POST": return handleLogin(req, res, kv);
    case "DELETE": return handleLogout(req, res);
    case "GET": return handleGetAdmin(req, res);
    default:
      res.setHeader("Allow", ["GET", "POST", "DELETE"]);
      return res.status(405).json({ success: false, error: "Method not allowed" });
  }
}

// ==================== POST — 管理员登录 ====================

async function handleLogin(req: NextApiRequest, res: NextApiResponse, kv?: KVNamespace) {
  const env = {
    JWT_SECRET: process.env.JWT_SECRET,
    ADMIN_USERNAME: process.env.ADMIN_USERNAME,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    ENVIRONMENT: process.env.ENVIRONMENT,
  };
  if (!env.JWT_SECRET) return res.status(500).json({ success: false, error: "JWT_SECRET 环境变量未配置" });
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) {
    return res.status(500).json({ success: false, error: "管理员账号未配置（ADMIN_USERNAME / ADMIN_PASSWORD）" });
  }

  try {
    const clientIp = getClientIp(req);

    // KV 持久化限流检查
    if (kv) {
      const recentFails = await getRecentFails(kv, clientIp);
      if (recentFails.length >= LOGIN_MAX_ATTEMPTS) {
        const lastFail = recentFails[recentFails.length - 1];
        const resetAt = new Date(lastFail + LOGIN_WINDOW_MS).toISOString();
        return res.status(429).json({
          success: false,
          error: "登录尝试次数过多（5 次/30 分钟），请稍后再试",
          resetAt,
        });
      }
    }

    const body = req.body as { username?: string; password?: string } | undefined;
    if (!body || typeof body !== "object") return res.status(400).json({ success: false, error: "请求格式错误" });

    const { username, password } = body;
    if (!username || !password) return res.status(400).json({ success: false, error: "用户名和密码不能为空" });

    // 直接比对环境变量中的用户名和密码
    if (username !== env.ADMIN_USERNAME || password !== env.ADMIN_PASSWORD) {
      // 密码错误 → KV 记录失败
      if (kv) {
        const fails = await getRecentFails(kv, clientIp);
        fails.push(Date.now());
        await saveFails(kv, clientIp, fails);
      }
      return res.status(401).json({ success: false, error: "用户名或密码错误" });
    }

    // 登录成功 → 清除该 IP 全部失败记录
    if (kv) {
      await kv.delete(kvKey(clientIp));
    }

    const isProd = env.ENVIRONMENT === "production";
    const token = await generateToken({ adminId: "env-admin", username: env.ADMIN_USERNAME! }, env);
    setAuthCookie(res, token, isProd);

    return res.status(200).json({ success: true, data: { username: env.ADMIN_USERNAME }, message: "登录成功" });
  } catch (error) {
    console.error("[auth] 登录异常:", error instanceof Error ? error.message : String(error));
    return res.status(500).json({ success: false, error: "登录失败", detail: error instanceof Error ? error.message : String(error) });
  }
}

// ==================== DELETE — 管理员登出 ====================

async function handleLogout(req: NextApiRequest, res: NextApiResponse) {
  const env = {
    JWT_SECRET: process.env.JWT_SECRET,
    ADMIN_USERNAME: process.env.ADMIN_USERNAME,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    ENVIRONMENT: process.env.ENVIRONMENT,
  };

  try {
    const admin = await getAdmin(req, env);
    const clientIp = getClientIp(req);
    clearAuthCookie(res);

    if (admin) {
      try {
        const db = await createDb();
        await db.auditLogs.create({
          data: {
            id: crypto.randomUUID(),
            adminId: getAuditAdminId(admin as AuthResult),
            action: "logout",
            detail: JSON.stringify({ username: admin.username }),
            ip: clientIp,
            createdAt: Math.floor(Date.now() / 1000),
          },
        });
      } catch { /* 审计日志写入失败不阻塞主流程 */ }
    }

    return res.status(200).json({ success: true, message: "已退出登录" });
  } catch (err) {
    console.error("[DELETE /api/admin/auth] 登出异常:", err);
    clearAuthCookie(res);
    return res.status(500).json({ success: false, error: "登出过程中发生错误，但登录状态已清除", detail: err instanceof Error ? err.message : String(err) });
  }
}

// ==================== GET — 获取当前管理员信息 ====================

async function handleGetAdmin(req: NextApiRequest, res: NextApiResponse) {
  const env = {
    JWT_SECRET: process.env.JWT_SECRET,
    ADMIN_USERNAME: process.env.ADMIN_USERNAME,
  };
  if (!env.JWT_SECRET) return res.status(500).json({ success: false, error: "JWT_SECRET 环境变量未配置" });

  try {
    const admin = await getAdmin(req, env);
    if (!admin) return res.status(401).json({ success: false, error: "未授权" });
    return res.status(200).json({ success: true, data: { adminId: admin.adminId, username: admin.username } });
  } catch (err) {
    console.error("[GET /api/admin/auth] 获取管理员信息失败:", err);
    return res.status(401).json({ success: false, error: "未授权", detail: err instanceof Error ? err.message : String(err) });
  }
}
