/**
 * 共享安全工具函数
 *
 * - SSRF 防护（含 DNS Rebinding 检测）
 * - CSRF 防护
 * - 输入净化
 */

import type { NextApiRequest, NextApiResponse } from "next";
// type-only 导入：编译期擦除，不影响 Pages/Worker 运行时
import type * as NodeDns from "node:dns";
import { isSafeUpstreamUrl, isPrivateIp } from "./ssrf";

// ==================== SSRF 防护 ====================

/**
 * 解析 URL 并检查是否指向内网地址（降低 DNS Rebinding 风险）
 *
 * 第一层：协议 + hostname/IP 字面量黑名单（复用 isSafeUpstreamUrl，
 * 含 IPv6 回环/ULA/链路本地/IPv4-mapped 规范化）。
 * 第二层：DNS 解析（A + AAAA）后逐 IP 校验，拦截 AAAA-only 内网域名与
 * 大部分 DNS Rebinding 场景（解析与连接间仍有 TOCTOU 窗口，属已知限制）。
 * IP 字面量直接跳过第二层：node:dns 不解析字面量（返回 ENOTFOUND），
 * 且第一层已覆盖全部内网段。
 * fail-closed：node:dns 不可用（无 nodejs_compat 的 workerd / 降级运行时）时
 * 拒绝域名型 URL，绝不静默放行——SSRF 防护缺失时宁可功能不可用。
 */
export async function isSafeUrl(urlStr: string): Promise<{ safe: boolean; reason?: string }> {
  const first = isSafeUpstreamUrl(urlStr);
  if (!first.safe) return first;

  const hostname = new URL(urlStr).hostname;

  // IP 字面量：第一层已判定非内网，无需（也无法）再做 DNS 解析
  const ipv4Parts = hostname.split(".");
  const isIpv4Literal = ipv4Parts.length === 4 && ipv4Parts.every((p) => /^\d{1,3}$/.test(p));
  if (isIpv4Literal || hostname.includes(":")) {
    return { safe: true };
  }

  // 第二层：DNS 解析后 IP 检查（防 DNS Rebinding / AAAA-only 内网域名）
  let dnsMod: typeof NodeDns;
  try {
    dnsMod = await import("node:dns");
  } catch {
    return { safe: false, reason: "DNS 解析能力不可用，拒绝域名型 URL" };
  }
  // ESM interop：CJS 形态（Node）走 dnsMod.promises，ESM 包装形态（workerd）走 default.promises
  const promises = (dnsMod as { default?: typeof NodeDns }).default?.promises ?? dnsMod.promises;
  if (!promises?.resolve4 || !promises?.resolve6) {
    return { safe: false, reason: "DNS 解析能力不可用，拒绝域名型 URL" };
  }
  const [v4, v6] = await Promise.all([
    promises.resolve4(hostname).catch(() => []),
    promises.resolve6(hostname).catch(() => []),
  ]);
  // 域名无法解析时 fail-closed（拒绝），不静默放行
  if (v4.length === 0 && v6.length === 0) {
    return { safe: false, reason: `域名 ${hostname} 无法解析` };
  }
  for (const addr of [...v4, ...v6]) {
    if (isPrivateIp(addr)) {
      return { safe: false, reason: `域名 ${hostname} 解析到内网地址 ${addr}` };
    }
  }

  return { safe: true };
}

// ==================== CSRF 防护 ====================

/**
 * 校验请求来源，防御 CSRF 攻击
 *
 * 检查 Origin 或 Referer 头是否匹配当前服务器。
 * 对 SameSite=Lax 无法覆盖的场景（如 GET 请求携带 Cookie）提供额外防护。
 *
 * 环境变量 CSRF_ALLOWED_ORIGINS（逗号分隔的域名列表）用于 CDN 等前置代理
 * 场景：代理回源时源站收到的 Host 是源站域名，而浏览器 Origin 是 CDN 域名，
 * 二者必然不同，命中白名单的域名来源视为合法。
 *
 * @returns true 表示来源合法，false 表示已被拦截（已发送 403 响应）
 */
export function checkCsrfOrigin(req: NextApiRequest, res: NextApiResponse): boolean {
  const origin = (req.headers.origin as string) || "";
  const referer = (req.headers.referer as string) || "";

  // 非生产环境：无 Origin 且无 Referer 时放行（本地开发 curl 等工具不发送这些头）
  // ENVIRONMENT 未设置时回退 NODE_ENV：next build/start 的运行时恒为 production，
  // 避免生产部署漏配 ENVIRONMENT 导致 Secure Cookie 与 CSRF 严格分支静默失效
  const isProd =
    process.env.ENVIRONMENT === "production" ||
    (process.env.ENVIRONMENT === undefined && process.env.NODE_ENV === "production");
  if (!origin && !referer) {
    if (isProd) {
      // 生产环境：POST/PUT/DELETE 请求必须有 Origin 或 Referer
      if (req.method && ["POST", "PUT", "DELETE", "PATCH"].includes(req.method)) {
        res.status(403).json({ success: false, error: "请求缺少来源标识" });
        return false;
      }
    }
    return true;
  }

  // 从 Origin/Referer 提取 host（hostname 不含端口，用于白名单匹配）
  let sourceHost = "";
  let sourceHostname = "";
  if (origin) {
    try {
      const url = new URL(origin);
      sourceHost = url.host;
      sourceHostname = url.hostname;
    } catch {
      // 提供了 Origin 但无法解析（畸形字符串 / "null"）→ 视为攻击，fail-closed
      res.status(403).json({ success: false, error: "请求来源不合法" });
      return false;
    }
  } else if (referer) {
    try {
      const url = new URL(referer);
      sourceHost = url.host;
      sourceHostname = url.hostname;
    } catch {
      res.status(403).json({ success: false, error: "请求来源不合法" });
      return false;
    }
  }

  // 获取当前请求的 host
  const reqHost = req.headers.host || "";

  // 仅在非生产环境允许 localhost 绕过
  // 端口形式同样放行（localhost:3000 与 127.0.0.1:3000 对称——此前仅
  // localhost 带端口命中，127.0.0.1:3000 跨 host 混合访问被单向误杀）
  const isLocalhost = (h: string) =>
    h === "localhost" ||
    h === "127.0.0.1" ||
    h.startsWith("localhost:") ||
    h.startsWith("127.0.0.1:");
  const localhostAllowed = !isProd && isLocalhost(sourceHost) && isLocalhost(reqHost);

  // 环境变量白名单：逗号分隔的域名列表（CDN 前置代理场景）
  // 归一化：允许用户配置带端口或带协议的域名
  const allowedOrigins = (process.env.CSRF_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((d) => {
      const raw = d.trim().toLowerCase();
      if (!raw) return "";
      try {
        if (raw.includes("://")) return new URL(raw).hostname.toLowerCase();
      } catch {}
      return raw.split(":")[0].split("/")[0];
    })
    .filter(Boolean);

  if (
    sourceHost &&
    sourceHost !== reqHost &&
    !localhostAllowed &&
    !allowedOrigins.includes(sourceHostname.toLowerCase())
  ) {
    res.status(403).json({ success: false, error: "请求来源不合法" });
    return false;
  }

  return true;
}
