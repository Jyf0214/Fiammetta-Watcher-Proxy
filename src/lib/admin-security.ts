/**
 * 共享安全工具函数
 *
 * - SSRF 防护（含 DNS Rebinding 检测）
 * - CSRF 防护
 * - 输入净化
 */

import type { NextApiRequest, NextApiResponse } from "next";
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
 */
export async function isSafeUrl(urlStr: string): Promise<{ safe: boolean; reason?: string }> {
  const first = isSafeUpstreamUrl(urlStr);
  if (!first.safe) return first;

  const hostname = new URL(urlStr).hostname;

  // IP 字面量：第一层已判定非内网，无需（也无法）再做 DNS 解析
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":")) {
    return { safe: true };
  }

  // 第二层：DNS 解析后 IP 检查（防 DNS Rebinding / AAAA-only 内网域名）
  // node:dns 不可用（Cloudflare Pages Functions）时降级为 hostname 黑名单防护；
  // 域名无法解析时 fail-closed（拒绝），不静默放行
  try {
    const dnsMod = (await import("node:dns")) as Record<string, any>;
    const promises = dnsMod.default?.promises ?? dnsMod.promises;
    if (promises?.resolve4) {
      const [v4, v6] = await Promise.all([
        promises.resolve4(hostname).catch(() => [] as string[]),
        promises.resolve6(hostname).catch(() => [] as string[]),
      ]);
      if (v4.length === 0 && v6.length === 0) {
        return { safe: false, reason: `域名 ${hostname} 无法解析` };
      }
      for (const addr of [...v4, ...v6]) {
        if (isPrivateIp(addr)) {
          return { safe: false, reason: `域名 ${hostname} 解析到内网地址 ${addr}` };
        }
      }
    }
  } catch {
    // node:dns 不可用（Cloudflare Pages Functions 环境）— 降级为 hostname 黑名单防护
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
    try { sourceHost = new URL(origin).host; } catch {
      // 提供了 Origin 但无法解析（畸形字符串 / "null"）→ 视为攻击，fail-closed
      res.status(403).json({ success: false, error: "请求来源不合法" });
      return false;
    }
  } else if (referer) {
    try { sourceHost = new URL(referer).host; } catch {
      res.status(403).json({ success: false, error: "请求来源不合法" });
      return false;
    }
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
