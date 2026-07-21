/**
 * URL 校验与 SSRF 防护工具（Cloudflare Workers 版）
 *
 * 验证 URL 格式合法性，阻止指向内网地址、链路本地地址、文件协议等
 * 危险目标的 URL，防止服务端请求伪造（SSRF）攻击。
 *
 * Workers 限制说明：
 * - 不支持 node:dns 模块，因此无法在运行时做 DNS 解析后校验（isResolvedAddressSafe）。
 * - 仅保留静态检查（isDangerousHostname），作为纯函数在边缘层执行。
 * - 静态检查能拦截直接使用 IP 地址或 localhost 的 SSRF，
 *   但无法防御 DNS 重绑定攻击（域名先解析到公网 IP，再切换为内网 IP）。
 * - 如需完整 DNS 解析校验，建议使用 Cloudflare Gateway 或 WAF 规则。
 */

/**
 * 检查 IPv4 地址是否属于内网/保留地址段
 * 涵盖：私有地址、链路本地、回环地址、0.0.0.0、广播地址等
 */
function isPrivateOrReservedIPv4(octets: number[] | string): boolean {
  const parts = typeof octets === "string" ? octets.split(".").map(Number) : octets;
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return false;
  }

  const [a, b, c] = parts;

  // 0.0.0.0/8 — 当前网络
  if (a === 0) return true;
  // 10.0.0.0/8 — A 类私有地址
  if (a === 10) return true;
  // 100.64.0.0/10 (RFC 6598 - CGN)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 — 回环地址
  if (a === 127) return true;
  // 169.254.0.0/16 — 链路本地地址
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 — B 类私有地址
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 0) return true;
  // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 0 && c === 2) return true;
  // 192.168.0.0/16 — C 类私有地址
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 198.51.100.0/24 (TEST-NET-2)
  if (a === 198 && b === 51 && c === 100) return true;
  // 203.0.113.0/24 (TEST-NET-3)
  if (a === 203 && b === 0 && c === 113) return true;
  // 224.0.0.0/4 (组播)
  if (a >= 224 && a <= 239) return true;
  // 240.0.0.0/4 (保留)
  if (a >= 240) return true;

  return false;
}

/**
 * 检查 IPv6 地址是否属于内网/保留地址段
 */
function isPrivateOrReservedIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();

  // 回环地址 ::1
  if (normalized === "::1") return true;
  // 链路本地 fe80::/10
  if (normalized.startsWith("fe80")) return true;
  // 唯一本地地址 fc00::/7
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  // 未指定地址 ::
  if (normalized === "::") return true;

  return false;
}

/**
 * 从主机名中提取 IP 地址进行内网检测
 * 处理 IPv4-mapped IPv6 格式（如 ::ffff:127.0.0.1）
 */
function isIpAddressInternal(hostname: string): boolean {
  // 处理 IPv4-mapped IPv6
  const ipv4MappedMatch = hostname.match(/^(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/i);
  if (ipv4MappedMatch) {
    return isPrivateOrReservedIPv4(ipv4MappedMatch[1]);
  }

  // 纯 IPv4
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    return isPrivateOrReservedIPv4(hostname);
  }

  // 纯 IPv6（去掉方括号）
  const ipv6 = hostname.replace(/^\[|\]$/g, "");
  if (ipv6.includes(":")) {
    return isPrivateOrReservedIPv6(ipv6);
  }

  return false;
}

/**
 * 检查主机名是否属于危险的内网目标（静态检查）
 *
 * 拦截内容：
 * - 十进制/十六进制整数 IP（如 2130706433 = 127.0.0.1）
 * - IPv4-mapped IPv6（如 ::ffff:127.0.0.1）
 * - localhost 及其变体
 * - 内网域名（.internal、.intranet）
 * - 内网 IP 地址（私有、回环、链路本地等）
 */
export function isDangerousHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();

  // 拦截十进制整数 IP 表示法（如 2130706433 = 127.0.0.1）
  if (/^\d+$/.test(lower)) return true;
  // 拦截十六进制格式（如 0x7f000001 = 127.0.0.1）
  if (/^0x[0-9a-f]+$/i.test(lower)) return true;

  // 拦截 IPv6 映射 IPv4 地址（如 ::ffff:127.0.0.1）
  if (/^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/i.test(lower)) {
    const [, a, b, c, d] = lower.match(/^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/i)!;
    const ip = [parseInt(a), parseInt(b), parseInt(c), parseInt(d)];
    if (isPrivateOrReservedIPv4(ip)) return true;
  }

  // localhost 及其各种变体
  if (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower === "local" ||
    lower.endsWith(".local")
  ) {
    return true;
  }

  // 内网域名
  if (lower.endsWith(".internal") || lower.endsWith(".intranet")) {
    return true;
  }

  // IP 地址检测
  if (isIpAddressInternal(lower)) {
    return true;
  }

  return false;
}

/** URL 校验结果 */
export interface UrlValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * 校验 URL 格式并执行 SSRF 防护检查（静态检查）
 *
 * 检查内容：
 * 1. URL 格式合法性（通过 new URL() 解析）
 * 2. 协议白名单（仅允许 http/https）
 * 3. 内网地址黑名单（localhost、私有 IP、链路本地地址等）
 * 4. 文件协议禁止
 *
 * 注意：此为静态检查，无法防御 DNS 重绑定攻击。
 * 如需完整防护，建议结合 Cloudflare Gateway 使用。
 */
export function validateUrlSafe(url: string): UrlValidationResult {
  // 格式校验
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, error: "URL 格式无效，请提供有效的 URL" };
  }

  // 协议白名单：仅允许 http 和 https
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      valid: false,
      error: `协议 ${parsed.protocol} 不被允许，仅支持 http 和 https`,
    };
  }

  // SSRF 防护：阻止内网地址
  if (isDangerousHostname(parsed.hostname)) {
    return {
      valid: false,
      error: "URL 指向内网地址，出于安全考虑不被允许",
    };
  }

  return { valid: true };
}

/**
 * 检查 URL 字符串是否安全（便捷函数，等价于 validateUrlSafe(url).valid）
 */
export function isUrlSafe(url: string): boolean {
  return validateUrlSafe(url).valid;
}
