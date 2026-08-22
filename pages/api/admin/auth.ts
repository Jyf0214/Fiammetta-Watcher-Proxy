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
import { checkCsrfOrigin } from "@/lib/admin-security";

const COOKIE_NAME = "admin_token";

// ==================== 速率限制（数据库滑动窗口，先写后查） ====================

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 30 * 60 * 1000;

/**
 * 进程内登录失败滑动窗口（ip → 失败时间戳数组）
 *
 * 与 DB 持久化计数并行的独立计数结构：审计日志不再承担计数职责，
 * login_failed 记录保持 append-only（登录成功不再 deleteMany 物理删除，
 * 否则审计记录丢失——历史 bug：把审计表当计数表复用）。
 * 内存窗口保证：DB 写入失败（fail-open 放行）时本进程仍可限流；
 * 登录成功时清空本进程计数（DB 记录保留，靠 30 分钟窗口自然过期）。
 */
const loginFailMemory = new Map<string, number[]>();

/** 记录一次登录失败（时间戳入窗，先记录后判定——与"先写后查"同序） */
function recordMemoryFail(ip: string): void {
  const ts = loginFailMemory.get(ip) ?? [];
  ts.push(Math.floor(Date.now() / 1000));
  loginFailMemory.set(ip, ts);
}

/** 统计窗口内失败数并清理窗口外时间戳（避免 Map 无限增长） */
function countMemoryFails(ip: string): number {
  const since = Math.floor(Date.now() / 1000) - LOGIN_WINDOW_MS / 1000;
  const ts = (loginFailMemory.get(ip) ?? []).filter((t) => t >= since);
  if (ts.length === 0) loginFailMemory.delete(ip);
  else loginFailMemory.set(ip, ts);
  return ts.length;
}

/** 登录成功清空该 IP 的进程内计数（DB 失败记录保留，append-only） */
function clearMemoryFails(ip: string): void {
  loginFailMemory.delete(ip);
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
 * 0. TRUSTED_IP_HEADER 环境变量显式指定的自定义可信请求头（如 X-Real-IP 或
 *    网关注入的自定义头）——配置后优先于一切部署平台方案，头缺失或为空时
 *    回退下方方案。仅当上游网关/反向代理强制覆盖该头（客户端无法伪造）时
 *    配置，否则攻击者可直接伪造该头绕过限流；
 * 1. EdgeOne 部署（DEPLOY_PLATFORM=edgeone，Makers 控制台环境变量，构建与运行时
 *    共享）：请求必经 EdgeOne 边缘，EO-Client-IP / EO-Connecting-IP 由边缘强制注入且
 *    客户端无法伪造，优先采信；X-Forwarded-For 由 EdgeOne 维护（首项为客户端真实 IP）
 *    作为回退。仅此部署平台采信——其他平台（Docker 显式 DEPLOY_PLATFORM=docker、
 *    Cloudflare、直连、未设置）EdgeOne 头完全不可信（攻击者可任意伪造绕过限流），一律忽略；
 * 2. Vercel 部署（DEPLOY_PLATFORM=vercel）：Vercel 边缘强制覆盖 X-Forwarded-For
 *    为真实客户端公网 IP 且不转发外部 IP（防 IP 伪造），并注入同值的
 *    x-vercel-forwarded-for / x-real-ip；x-vercel-forwarded-for 为 Vercel 专属头
 *   （上层代理覆盖 XFF 时仍保留真实值），优先采信，回退 XFF / X-Real-IP。
 *    仅此部署平台采信（其他平台可任意伪造这些头）；
 * 3. 无 TCP 对端概念的边缘运行时（Next adapter 模式下 req.socket.remoteAddress
 *    为 undefined，如 Cloudflare Pages/Workers）— 前置头由边缘强制注入且客户端
 *    无法伪造，采信 CF-Connecting-IP；
 * 4. 直连（socket 对端不在 TRUSTED_PROXY_IPS 内）— X-Forwarded-For /
 *    CF-Connecting-IP 等前置头完全不可信（攻击者可任意伪造），直接使用 TCP
 *    对端地址（攻击者无法伪造 socket 地址）；
 * 5. 经可信代理（socket 对端在 TRUSTED_PROXY_IPS 内）— 从右向左跳过可信代理，
 *    取第一个不可信条目作为真实客户端；
 * 6. 全可信链或链为空时回退 X-Real-IP（可信代理设置的单值头）。
 *
 * 返回 null 仅发生在极端环境（无平台头且无 socket 地址）；调用方此时应跳过
 * 限流（fail-open），禁止把不同来源归入同一个共享桶——否则攻击者可预填共享
 * 桶制造全平台登录 DoS（历史漏洞：所有来源统一回退为 "unknown"）。
 */
export function getClientIp(req: NextApiRequest): string | null {
  const socketIp = normalizeIp(req.socket?.remoteAddress ?? "");

  // TRUSTED_IP_HEADER：显式指定自定义可信请求头（如 X-Real-IP 或网关注入的
  // 自定义头），优先级高于下方各部署平台方案。仅当上游网关/反向代理强制覆盖
  // 该头（客户端无法伪造）时配置——否则攻击者可直接伪造该头绕过限流。
  // 头缺失、为空或首项为空白时回退平台方案，保持默认行为不变
  const trustedHeader = process.env.TRUSTED_IP_HEADER?.trim().toLowerCase();
  if (trustedHeader) {
    // 头名大小写不敏感（Node 的 req.headers 键为小写，用户配置可能带大小写）
    const key = Object.keys(req.headers).find((h) => h.toLowerCase() === trustedHeader);
    const value = firstHeaderValue(key ? req.headers[key] : undefined);
    // 与平台方案同规则：逗号分隔取首项（最靠近客户端的条目），IPv4-mapped 归一化；
    // 畸形形态（前导逗号等）回退平台方案而非 fail-open
    const first = value?.split(",")[0]?.trim();
    if (first) return normalizeIp(first);
  }

  // EdgeOne 部署：采信边缘强制注入的专属头（大小写不敏感，仅当 DEPLOY_PLATFORM=edgeone，
  // 防止其他部署方案因伪造 EdgeOne 头绕过限流）
  if ((process.env.DEPLOY_PLATFORM ?? "").toLowerCase() === "edgeone") {
    const eoIp =
      firstHeaderValue(req.headers["eo-client-ip"]) ??
      firstHeaderValue(req.headers["eo-connecting-ip"]);
    if (eoIp) return normalizeIp(eoIp);
    const eoXff = firstHeaderValue(req.headers["x-forwarded-for"]);
    if (eoXff) {
      const first = normalizeIp(eoXff.split(",")[0] ?? eoXff);
      if (first) return first;
    }
    // EdgeOne 专属头缺失（异常形态）时回退 TCP 对端（边缘节点 IP），
    // 不落入下方 CF-Connecting-IP 信任分支——EdgeOne 不注入该头，直连伪造不可信
    return socketIp || null;
  }

  // Vercel 部署：Vercel 边缘强制覆盖 X-Forwarded-For 为真实客户端公网 IP
  // （不转发外部 IP，防 IP 伪造），并注入同值的 x-vercel-forwarded-for /
  // x-real-ip。x-vercel-forwarded-for 为 Vercel 专属头（上层代理覆盖 XFF 时
  // 仍保留真实值），优先采信。仅当 DEPLOY_PLATFORM=vercel 时采信，防止
  // 其他部署方案因伪造这些头绕过限流（大小写不敏感）
  if ((process.env.DEPLOY_PLATFORM ?? "").toLowerCase() === "vercel") {
    const vercelIp =
      firstHeaderValue(req.headers["x-vercel-forwarded-for"]) ??
      firstHeaderValue(req.headers["x-forwarded-for"]) ??
      firstHeaderValue(req.headers["x-real-ip"]);
    if (vercelIp) {
      const first = normalizeIp(vercelIp.split(",")[0] ?? vercelIp);
      if (first) return first;
    }
    // Vercel 头缺失（异常形态）时回退 TCP 对端（Vercel 内部地址），
    // 不落入下方 CF-Connecting-IP 信任分支——Vercel 不注入该头，直连伪造不可信
    return socketIp || null;
  }

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
 * 登录限流"先写后查"：每次失败先插入一条 login_failed 记录（审计，append-only），
 * 再统计最近 30 分钟的失败数。并发请求各自插入后再计数，读取到的计数必然
 * 包含本次及之前的尝试——消除了"先查后写"下 count 与 insert 之间的
 * TOCTOU 竞态窗口（此前并发突刺可让全部请求同时读到低计数而绕过上限）。
 * 计数超过上限（第 6 条起）即拒绝；登录成功时调用方会清空该 IP 的
 * 进程内计数（clearMemoryFails），DB 记录不再删除、靠窗口自然过期。
 * 正确性前提：单库强一致（读自己的写）。TiDB serverless 单端点 / 单库部署
 * 成立；若未来引入从库读/多区域读，此方案需重新评估。
 * DB 故障时放行（fail-open，限流是防滥用而非安全边界），但记录错误日志，
 * 避免限流静默失效（历史教训：审计写入失败曾被静默吞掉）；
 * DB 故障时进程内计数（loginFailMemory）仍生效，限流不因 DB 故障完全失效。
 */
async function registerDbLoginAttempt(
  ip: string,
  username: string,
  reason = "登录尝试"
): Promise<{ limited: boolean; resetAt?: string }> {
  // 先记录进程内计数（独立于 DB 结果，DB 写失败也计入）
  recordMemoryFail(ip);
  try {
    const now = Math.floor(Date.now() / 1000);
    // 先写入本次尝试的审计记录（append-only，不再被删除）；未登录无管理员身份，adminId 置 null
    await writeAuditLog("login_failed", { username, reason }, ip, null);
    const db = await createDb();
    const since = now - LOGIN_WINDOW_MS / 1000;
    const fails = await db.auditLogs.count({
      where: { action: "login_failed", ip, createdAt: { gte: since } },
    });
    const memFails = countMemoryFails(ip);
    if (fails > LOGIN_MAX_ATTEMPTS || memFails > LOGIN_MAX_ATTEMPTS) {
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
    // DB 不可用时退回进程内计数：仍超限则拒绝
    if (countMemoryFails(ip) > LOGIN_MAX_ATTEMPTS) {
      return { limited: true };
    }
    return { limited: false };
  }
}

/**
 * 只读查询某 IP 最近 30 分钟的登录失败计数（预检用）。
 * 不写入任何记录；并发安全由失败分支的"先写后查"（registerDbLoginAttempt）
 * 保证，预检只是让已超限的 IP 快速被拒、避免持续写库。
 * 计数取 DB 与进程内窗口的较大者（重启后内存丢失，DB 兜底；DB 故障时内存兜底）。
 */
async function readDbLoginFailInfo(ip: string): Promise<{ count: number; resetAt?: string }> {
  try {
    const db = await createDb();
    const since = Math.floor(Date.now() / 1000) - LOGIN_WINDOW_MS / 1000;
    const count = await db.auditLogs.count({
      where: { action: "login_failed", ip, createdAt: { gte: since } },
    });
    const memFails = countMemoryFails(ip);
    const total = Math.max(count, memFails);
    if (total === 0) return { count: 0 };
    const last = await db.auditLogs.findFirst({
      where: { action: "login_failed", ip, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
    });
    const resetAt = last
      ? new Date((last.createdAt + LOGIN_WINDOW_MS / 1000) * 1000).toISOString()
      : undefined;
    return { count: total, resetAt };
  } catch (err) {
    console.error(
      "[auth] 登录失败计数查询异常（预检放行）:",
      err instanceof Error ? err.message : String(err)
    );
    return { count: countMemoryFails(ip) };
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
  // 登录会写入 Cookie 与审计日志，属于写操作：校验来源防 login CSRF
  // （跨站表单伪造登录请求）；非生产环境无来源标识/本地开发放行
  if (!checkCsrfOrigin(req, res)) return;

  const env = {
    JWT_SECRET: process.env.JWT_SECRET,
    ADMIN_USERNAME: process.env.ADMIN_USERNAME,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    ENVIRONMENT: process.env.ENVIRONMENT,
  };
  // 未认证调用方不暴露部署/配置细节（JWT_SECRET 是否配置、最小长度、
  // 管理员账号是否就绪），否则响应状态差异会成为配置状态枚举 oracle；
  // 具体原因只写服务端日志
  if (!env.JWT_SECRET) {
    console.error("[POST /api/admin/auth] JWT_SECRET 环境变量未配置");
    return res.status(500).json({ success: false, error: "服务器配置错误，请检查部署配置" });
  }
  if (env.JWT_SECRET.length < MIN_JWT_SECRET_LENGTH) {
    console.error(`[POST /api/admin/auth] JWT_SECRET 强度不足：至少需要 ${MIN_JWT_SECRET_LENGTH} 个字符`);
    return res.status(500).json({ success: false, error: "服务器配置错误，请检查部署配置" });
  }
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) {
    console.error("[POST /api/admin/auth] 管理员账号未配置（ADMIN_USERNAME / ADMIN_PASSWORD）");
    return res.status(500).json({ success: false, error: "服务器配置错误，请检查部署配置" });
  }

  try {
    // getClientIp 可能返回 null（如无可信代理头），用 remoteAddress 兜底，
    // 两者都不可得时用 "unknown" 确保限流始终生效，防止暴力破解
    const clientIp = getClientIp(req) || req.socket?.remoteAddress || "unknown";

    // 数据库限流预检：已超限的 IP 直接拒绝（不写入，避免超限后仍持续写库）；
    // 权威判定在失败分支的"先写后查"（registerDbLoginAttempt），并发突刺
    // 即使穿过预检也会在写后计数处被统一拦截
    {
      const preCheck = await readDbLoginFailInfo(clientIp);
      if (preCheck.count >= LOGIN_MAX_ATTEMPTS) {
        return res.status(429).json({
          success: false,
          error: `登录尝试次数过多（${LOGIN_MAX_ATTEMPTS} 次/${LOGIN_WINDOW_MS / 60000} 分钟），请稍后再试`,
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
      // clientIp 在入口处已做 remoteAddress / "unknown" 兜底，永非空
      const dbLimit = await registerDbLoginAttempt(clientIp, username, "用户名或密码错误");
      if (dbLimit.limited) {
        return res.status(429).json({
          success: false,
          error: `登录尝试次数过多（${LOGIN_MAX_ATTEMPTS} 次/${LOGIN_WINDOW_MS / 60000} 分钟），请稍后再试`,
          resetAt: dbLimit.resetAt,
        });
      }
      return res.status(401).json({ success: false, error: "用户名或密码错误" });
    }

    // 登录成功 → 清空该 IP 的进程内失败计数（审计失败记录保持 append-only，
    // 不再 deleteMany 物理删除——审计表承担展示职责，不被当作计数表复用；
    // DB 记录靠 30 分钟滑动窗口自然过期）+ 审计
    clearMemoryFails(clientIp);
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
    console.error("[DELETE /api/admin/auth] 登出异常:", err instanceof Error ? err.message : String(err));
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
  if (!env.JWT_SECRET) {
    console.error("[GET /api/admin/auth] JWT_SECRET 环境变量未配置");
    return res.status(500).json({ success: false, error: "服务器配置错误，请检查部署配置" });
  }

  try {
    const admin = await getAdmin(req, env);
    if (!admin) return res.status(401).json({ success: false, error: "未授权" });
    return res.status(200).json({ success: true, data: { adminId: admin.adminId, username: admin.username } });
  } catch (err) {
    console.error("[GET /api/admin/auth] 获取管理员信息失败:", err instanceof Error ? err.message : String(err));
    return res.status(401).json({ success: false, error: "未授权" });
  }
}
