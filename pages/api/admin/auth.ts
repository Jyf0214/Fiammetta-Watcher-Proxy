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

// ==================== 速率限制（数据库滑动窗口，先写后查） ====================

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 30 * 60 * 1000;

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

/** 归一化 IP：剥离 IPv6 方括号，IPv4-mapped（::ffff:a.b.c.d）还原为点分十进制 */
function normalizeIp(ip: string): string {
  const t = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return t.startsWith("::ffff:") && t.includes(".") ? t.slice(7) : t;
}

function firstHeaderValue(h: string | string[] | undefined): string | undefined {
  if (!h) return undefined;
  const v = Array.isArray(h) ? h[0] : h;
  return v.trim() || undefined;
}

/**
 * 解析真实客户端 IP（可信代理链）。
 *
 * 优先级：
 * 1. 无 TCP 对端概念的边缘运行时（Next adapter 模式下 req.socket.remoteAddress
 *    为 undefined，如 Cloudflare Pages/Workers）— 前置头由边缘强制注入且客户端
 *    无法伪造，采信 CF-Connecting-IP；
 * 2. 直连（socket 对端不在 TRUSTED_PROXY_IPS 内）— X-Forwarded-For /
 *    CF-Connecting-IP 等前置头完全不可信（攻击者可任意伪造），直接使用 TCP
 *    对端地址（攻击者无法伪造 socket 地址）；
 * 3. 经可信代理（socket 对端在 TRUSTED_PROXY_IPS 内）— 从右向左跳过可信代理，
 *    取第一个不可信条目作为真实客户端；
 * 4. 全可信链或链为空时回退 X-Real-IP（可信代理设置的单值头）。
 *
 * 返回 null 仅发生在极端环境（无 CF 头且无 socket 地址）；调用方此时应跳过
 * 限流（fail-open），禁止把不同来源归入同一个共享桶——否则攻击者可预填共享
 * 桶制造全平台登录 DoS（历史漏洞：所有来源统一回退为 "unknown"）。
 */
export function getClientIp(req: NextApiRequest): string | null {
  const socketIp = normalizeIp(req.socket?.remoteAddress ?? "");

  const trustedProxies = (process.env.TRUSTED_PROXY_IPS ?? "")
    .split(",")
    .map((s) => normalizeIp(s))
    .filter(Boolean);

  // 边缘运行时（无 TCP 对端概念）：采信边缘注入的 CF-Connecting-IP
  if (!socketIp) {
    const cfIp = firstHeaderValue(req.headers["cf-connecting-ip"]);
    return cfIp ? normalizeIp(cfIp) : null;
  }

  if (!trustedProxies.includes(socketIp)) return socketIp;

  // socket 对端是可信代理：XFF 链从右向左取第一个非可信代理的条目
  const xff = firstHeaderValue(req.headers["x-forwarded-for"]);
  if (xff) {
    const chain = xff.split(",").map(normalizeIp).filter(Boolean);
    for (let i = chain.length - 1; i >= 0; i--) {
      if (!trustedProxies.includes(chain[i])) return chain[i];
    }
  }
  const realIp = firstHeaderValue(req.headers["x-real-ip"]);
  return realIp ? normalizeIp(realIp) : null;
}

/** 审计日志详情（与各调用点写入的结构一致） */
interface AuditDetail {
  username: string;
  reason?: string;
}

/** 写入审计日志（写入失败向上抛出，由调用方决定处理方式） */
async function writeAuditLog(
  action: "login_failed" | "login_success" | "logout",
  detail: AuditDetail,
  ip: string | null,
  adminId: string | null,
): Promise<void> {
  const db = await createDb();
  await db.auditLogs.create({
    data: {
      id: crypto.randomUUID(),
      adminId,
      action,
      detail: JSON.stringify(detail),
      // 审计中的 unknown 仅作展示，不参与限流计数（限流键为 null 时跳过）
      ip: ip ?? "unknown",
      createdAt: Math.floor(Date.now() / 1000),
    },
  });
}

/**
 * 登录限流"先写后查"：每次失败先插入一条 login_failed 占位记录（即审计日志），
 * 再统计最近 30 分钟的失败数。并发请求各自插入后再计数，读取到的计数必然
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
    const now = Math.floor(Date.now() / 1000);
    // 先写入本次尝试的占位记录（即审计日志）；未登录无管理员身份，adminId 置 null
    await writeAuditLog("login_failed", { username, reason }, ip, null);
    const db = await createDb();
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
  switch (req.method) {
    case "POST": return handleLogin(req, res);
    case "DELETE": return handleLogout(req, res);
    case "GET": return handleGetAdmin(req, res);
    default:
      res.setHeader("Allow", ["GET", "POST", "DELETE"]);
      return res.status(405).json({ success: false, error: "Method not allowed" });
  }
}

// ==================== POST — 管理员登录 ====================

async function handleLogin(req: NextApiRequest, res: NextApiResponse) {
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

    // 数据库限流预检：已超限的 IP 直接拒绝（不写入，避免超限后仍持续写库）；
    // 权威判定在失败分支的"先写后查"（registerDbLoginAttempt），并发突刺
    // 即使穿过预检也会在写后计数处被统一拦截
    if (clientIp) {
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
      // 先写后查（占位记录即审计日志），超限返回 429；
      // IP 不可得（极端环境）时仅写审计、限流放行，不归入共享桶
      if (clientIp) {
        const dbLimit = await registerDbLoginAttempt(clientIp, username, "用户名或密码错误");
        if (dbLimit.limited) {
          return res.status(429).json({
            success: false,
            error: "登录尝试次数过多（5 次/30 分钟），请稍后再试",
            resetAt: dbLimit.resetAt,
          });
        }
      } else {
        // IP 不可得多为代理配置错误（可信代理未设 XFF/X-Real-IP），打日志避免限流静默失效
        console.warn("[auth] 无法确定客户端 IP，本次限流跳过（请检查代理配置）");
        await writeAuditLog("login_failed", { username, reason: "用户名或密码错误" }, null, "unknown").catch(() => {});
      }
      return res.status(401).json({ success: false, error: "用户名或密码错误" });
    }

    // 登录成功 → 清除该 IP 的 login_failed 审计记录（DB 限流计数归零）+ 审计
    if (clientIp) {
      try {
        const db = await createDb();
        await db.auditLogs.deleteMany({
          where: { action: "login_failed", ip: clientIp },
        });
      } catch { /* 清除失败不阻塞主流程，下次登录仍可用 */ }
    }
    await writeAuditLog("login_success", { username: env.ADMIN_USERNAME }, clientIp, "env-admin").catch(() => {});

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
      await writeAuditLog(
        "logout",
        { username: admin.username },
        clientIp,
        getAuditAdminId(admin as AuthResult),
      ).catch(() => {});
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
