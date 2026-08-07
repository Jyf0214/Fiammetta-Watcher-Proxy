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
import { generateToken, verifyToken, type AdminPayload } from "@/lib/auth";
import { createDb } from "@/lib/prisma";
import { getAuditAdminId, type AuthResult } from "@/lib/admin-auth";

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

/** JWT_SECRET 最小长度（防止弱密钥被暴力破解） */
const MIN_JWT_SECRET_LENGTH = 32;

/** 常量时间字符串比较，防止时序攻击 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  if (bufA.length !== bufB.length) {
    let result = bufA.length ^ bufB.length;
    for (let i = 0; i < bufA.length; i++) {
      result |= bufA[i] ^ (bufB[i % bufB.length] || 0);
    }
    return result === 0;
  }
  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}

function getClientIp(req: NextApiRequest): string {
  const forwarded = req.headers["x-forwarded-for"];
  const str = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return str?.split(",")[0]?.trim() || (req.headers["x-real-ip"] as string) || "unknown";
}

/**
 * 非 KV 平台（EdgeOne/Vercel/纯 Node）的登录限流兜底。
 *
 * 采用"先写后查"：每次尝试先插入一条 login_failed 占位记录，再统计
 * 最近 30 分钟的失败数。并发请求各自插入后再计数，读取到的计数必然
 * 包含本次及之前的尝试——消除了"先查后写"下 count 与 insert 之间的
 * TOCTOU 竞态窗口（此前并发突刺可让全部请求同时读到低计数而绕过上限）。
 * 计数超过上限（第 6 条起）即拒绝；登录成功时调用方会清除该 IP 的
 * 全部失败记录（占位随成功一并清除）。
 * 正确性前提：单库强一致（读自己的写）。TiDB serverless 单端点 / 单库部署
 * 成立；若未来引入从库读/多区域读，此方案需重新评估。
 * DB 故障时放行（fail-open，限流是防滥用而非安全边界），但记录错误日志，
 * 避免限流静默失效（历史教训：审计写入失败曾被静默吞掉）。
 */
async function registerDbLoginAttempt(
  ip: string,
  username: string,
  reason = "登录尝试"
): Promise<{ limited: boolean; resetAt?: string }> {
  try {
    const db = await createDb();
    const now = Math.floor(Date.now() / 1000);
    // 先写入本次尝试的占位记录
    await db.auditLogs.create({
      data: {
        id: crypto.randomUUID(),
        adminId: "unknown",
        action: "login_failed",
        detail: JSON.stringify({ username, reason }),
        ip,
        createdAt: now,
      },
    });
    const since = now - LOGIN_WINDOW_MS / 1000;
    const fails = await db.auditLogs.count({
      where: { action: "login_failed", ip, createdAt: { gte: since } },
    });
    if (fails > LOGIN_MAX_ATTEMPTS) {
      // resetAt 用最近一次失败的窗口到期时间近似
      const last = await db.auditLogs.findFirst({
        where: { action: "login_failed", ip, createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
      });
      const resetAt = last
        ? new Date((last.createdAt + LOGIN_WINDOW_MS / 1000) * 1000).toISOString()
        : undefined;
      return { limited: true, resetAt };
    }
    return { limited: false };
  } catch (err) {
    console.error(
      "[auth] 登录失败计数写入异常（本次限流放行）:",
      err instanceof Error ? err.message : String(err)
    );
    return { limited: false };
  }
}

/**
 * 只读查询某 IP 最近 30 分钟的登录失败计数（预检用）。
 * 不写入任何记录；并发安全由失败分支的"先写后查"（registerDbLoginAttempt）
 * 保证，预检只是让已超限的 IP 快速被拒、避免持续写库。
 */
async function readDbLoginFailInfo(ip: string): Promise<{ count: number; resetAt?: string }> {
  try {
    const db = await createDb();
    const since = Math.floor(Date.now() / 1000) - LOGIN_WINDOW_MS / 1000;
    const count = await db.auditLogs.count({
      where: { action: "login_failed", ip, createdAt: { gte: since } },
    });
    if (count === 0) return { count };
    const last = await db.auditLogs.findFirst({
      where: { action: "login_failed", ip, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
    });
    const resetAt = last
      ? new Date((last.createdAt + LOGIN_WINDOW_MS / 1000) * 1000).toISOString()
      : undefined;
    return { count, resetAt };
  } catch (err) {
    console.error(
      "[auth] 登录失败计数查询异常（预检放行）:",
      err instanceof Error ? err.message : String(err)
    );
    return { count: 0 };
  }
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
    // 动态加载 CF 运行时 API：仅 Cloudflare 平台启用 KV 登录限流，
    // 非 CF 平台（EdgeOne/Vercel/纯 Node）降级为不限流，避免运行时依赖缺失
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
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
  if (env.JWT_SECRET.length < MIN_JWT_SECRET_LENGTH) {
    return res.status(500).json({ success: false, error: `JWT_SECRET 强度不足：至少需要 ${MIN_JWT_SECRET_LENGTH} 个字符` });
  }
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) {
    return res.status(500).json({ success: false, error: "管理员账号未配置（ADMIN_USERNAME / ADMIN_PASSWORD）" });
  }

  try {
    const clientIp = getClientIp(req);

    // KV 持久化限流检查（CF 平台）
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
    } else {
      // 非 CF 平台：数据库兜底限流（audit_logs 失败计数）
      // 只读预检：已超限的 IP 直接拒绝（不写入，避免超限后仍持续写库）；
      // 权威判定在失败分支的"先写后查"（registerDbLoginAttempt），并发突刺
      // 即使穿过预检也会在写后计数处被统一拦截
      const preCheck = await readDbLoginFailInfo(clientIp);
      if (preCheck.count >= LOGIN_MAX_ATTEMPTS) {
        return res.status(429).json({
          success: false,
          error: "登录尝试次数过多（5 次/30 分钟），请稍后再试",
          resetAt: preCheck.resetAt,
        });
      }
    }

    const body = req.body as { username?: string; password?: string } | undefined;
    if (!body || typeof body !== "object") return res.status(400).json({ success: false, error: "请求格式错误" });

    const { username, password } = body;
    if (!username || !password) return res.status(400).json({ success: false, error: "用户名和密码不能为空" });

    // 常量时间比对用户名和密码，防止时序攻击
    const usernameMatch = timingSafeStringEqual(username, env.ADMIN_USERNAME);
    const passwordMatch = timingSafeStringEqual(password, env.ADMIN_PASSWORD);
    if (!usernameMatch || !passwordMatch) {
      // 密码错误 → KV 记录失败 + 审计日志
      if (kv) {
        const fails = await getRecentFails(kv, clientIp);
        fails.push(Date.now());
        await saveFails(kv, clientIp, fails);
        try {
          const db = await createDb();
          await db.auditLogs.create({
            data: {
              id: crypto.randomUUID(),
              adminId: "unknown",
              action: "login_failed",
              detail: JSON.stringify({ username, reason: "用户名或密码错误" }),
              ip: clientIp,
              createdAt: Math.floor(Date.now() / 1000),
            },
          });
        } catch { /* 审计日志写入失败不阻塞主流程 */ }
      } else {
        // 非 CF 平台：先写后查（占位记录即审计日志），超限返回 429
        const dbLimit = await registerDbLoginAttempt(clientIp, username, "用户名或密码错误");
        if (dbLimit.limited) {
          return res.status(429).json({
            success: false,
            error: "登录尝试次数过多（5 次/30 分钟），请稍后再试",
            resetAt: dbLimit.resetAt,
          });
        }
      }
      return res.status(401).json({ success: false, error: "用户名或密码错误" });
    }

    // 登录成功 → 清除该 IP 全部失败记录 + 审计日志
    if (kv) {
      await kv.delete(kvKey(clientIp));
    } else {
      // 非 CF 平台：清除该 IP 的 login_failed 审计记录（DB 兜底限流计数归零）
      try {
        const db = await createDb();
        await db.auditLogs.deleteMany({
          where: { action: "login_failed", ip: clientIp },
        });
      } catch { /* 清除失败不阻塞主流程，下次登录仍可用 */ }
    }
    try {
      const db = await createDb();
      await db.auditLogs.create({
        data: {
          id: crypto.randomUUID(),
          adminId: "env-admin",
          action: "login_success",
          detail: JSON.stringify({ username: env.ADMIN_USERNAME }),
          ip: clientIp,
          createdAt: Math.floor(Date.now() / 1000),
        },
      });
    } catch { /* 审计日志写入失败不阻塞主流程 */ }

    const isProd = env.ENVIRONMENT === "production";
    const token = await generateToken({ adminId: "env-admin", username: env.ADMIN_USERNAME! }, env);
    setAuthCookie(res, token, isProd);

    return res.status(200).json({ success: true, data: { username: env.ADMIN_USERNAME }, message: "登录成功" });
  } catch (error) {
    console.error("[auth] 登录异常:", error instanceof Error ? error.message : String(error));
    return res.status(500).json({ success: false, error: "登录失败" });
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
    return res.status(500).json({ success: false, error: "登出过程中发生错误，但登录状态已清除" });
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
    return res.status(401).json({ success: false, error: "未授权" });
  }
}
