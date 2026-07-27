/**
 * 共享安全工具函数
 *
 * - SSRF 防护（含 DNS Rebinding 检测）
 * - CSRF 防护
 * - 输入净化
 */

import type { NextApiRequest, NextApiResponse } from "next";

// ==================== SSRF 防护 ====================

/** 内网地址正则匹配 */
const PRIVATE_IP_PATTERNS = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^127\./,
  /^0\./,
];

/** 检查 IP 是否为内网地址 */
function isPrivateIp(ip: string): boolean {
  // IPv4 内网地址
  if (PRIVATE_IP_PATTERNS.some((p) => p.test(ip))) return true;
  // IPv6 本地地址
  if (ip === "::1" || ip === "[::1]" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80")) return true;
  // IPv4-mapped IPv6
  if (ip.startsWith("::ffff:")) {
    const mapped = ip.slice(7);
    if (PRIVATE_IP_PATTERNS.some((p) => p.test(mapped))) return true;
  }
  return false;
}

/**
 * 解析 URL 并检查是否指向内网地址（含 DNS Rebinding 防护）
 *
 * 先做 hostname 字符串校验，再做 DNS 解析后 IP 校验。
 * 两层都通过才算安全。
 */
export async function isSafeUrl(urlStr: string): Promise<{ safe: boolean; reason?: string }> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return { safe: false, reason: "URL 格式不合法" };
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    return { safe: false, reason: "URL 协议必须是 http 或 https" };
  }

  const hostname = url.hostname;

  // 第一层：hostname 字符串黑名单
  if (
    hostname === "localhost" ||
    hostname === "0.0.0.0" ||
    hostname === "127.0.0.1" ||
    PRIVATE_IP_PATTERNS.some((p) => p.test(hostname)) ||
    hostname === "[::1]" ||
    hostname === "::1"
  ) {
    return { safe: false, reason: "URL 不能指向内网或本地地址" };
  }

  // 第二层：DNS 解析后 IP 检查（防 DNS Rebinding）
  // 在支持 node:dns 的环境中启用（如 Node.js 本地开发），
  // 在 Cloudflare Pages Functions 中优雅降级（保留 hostname 黑名单防护）
  try {
    const dnsMod = await import("node:dns");
    const resolve4 = dnsMod.default?.resolve4 ?? (dnsMod as Record<string, unknown>).resolve4 as ((host: string, cb: (err: Error | null, addrs: string[]) => void) => void) | undefined;
    if (resolve4) {
      const addresses = await new Promise<string[]>((resolve, reject) => {
        resolve4(hostname, (err: Error | null, addrs: string[]) => {
          if (err) reject(err);
          else resolve(addrs);
        });
      });

      for (const addr of addresses) {
        if (isPrivateIp(addr)) {
          return { safe: false, reason: `域名 ${hostname} 解析到内网地址 ${addr}` };
        }
      }
    }
    // node:dns 不可用时静默跳过（hostname 黑名单已提供基础防护）
  } catch {
    // node:dns 不可用（Cloudflare Pages Functions 环境）— 静默跳过，
    // 依赖 hostname 字符串黑名单提供基础 SSRF 防护
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
 * @returns true 表示来源合法，false 表示已被拦截（已发送 403 响应）
 */
export function checkCsrfOrigin(req: NextApiRequest, res: NextApiResponse): boolean {
  const origin = (req.headers.origin as string) || "";
  const referer = (req.headers.referer as string) || "";

  // 非生产环境：无 Origin 且无 Referer 时放行（本地开发 curl 等工具不发送这些头）
  const isProd = process.env.ENVIRONMENT === "production";
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

  // 从 Origin/Referer 提取 host
  let sourceHost = "";
  if (origin) {
    try { sourceHost = new URL(origin).host; } catch { /* 无效 Origin */ }
  } else if (referer) {
    try { sourceHost = new URL(referer).host; } catch { /* 无效 Referer */ }
  }

  // 获取当前请求的 host
  const reqHost = req.headers.host || "";

  // 仅在非生产环境允许 localhost 绕过
  const isLocalhost = (h: string) =>
    h === "localhost" || h === "127.0.0.1" || h.startsWith("localhost:");
  const localhostAllowed = !isProd && isLocalhost(sourceHost) && isLocalhost(reqHost);

  if (sourceHost && sourceHost !== reqHost && !localhostAllowed) {
    res.status(403).json({ success: false, error: "请求来源不合法" });
    return false;
  }

  return true;
}

// ==================== 输入净化 ====================

/** HTML 特殊字符转义，防止存储型 XSS */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}
