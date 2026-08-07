/**
 * SSRF 防护共享工具（Pages / Worker 共用）
 *
 * 同步 hostname/IP 校验，供 v1 代理、平台模型发现、管理端写时校验使用：
 * - IPv4 内网段、IPv6 回环/ULA/链路本地、IPv4-mapped IPv6 字面量
 *
 * 注意：URL.hostname 对 IPv6 字面量恒返回带方括号形式（如 "[::ffff:127.0.0.1]"），
 * 校验前必须先剥离方括号，否则 fc/fd/fe80/::ffff 前缀匹配全部失配。
 */

/** 内网地址正则匹配 */
const PRIVATE_IP_PATTERNS = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^127\./,
  /^0\./,
];

/** 剥离 IPv6 字面量方括号并统一小写 */
function normalizeHost(host: string): string {
  const t = host.trim().toLowerCase();
  return t.startsWith("[") && t.endsWith("]") ? t.slice(1, -1) : t;
}

/** 判断 IP 是否为内网/本地地址（IPv4 段 + IPv6 回环/ULA/链路本地 + IPv4-mapped） */
export function isPrivateIp(ip: string): boolean {
  const n = normalizeHost(ip);
  if (PRIVATE_IP_PATTERNS.some((p) => p.test(n))) return true;
  if (n === "::1" || n === "::") return true;
  // IPv6 ULA（fc00::/7）与链路本地（fe80::/10，即 fe80-febf）
  if (n.startsWith("fc") || n.startsWith("fd") || /^fe[89ab]/.test(n)) return true;
  // IPv4-mapped IPv6（::ffff:a.b.c.d）→ 递归判定映射的 IPv4
  if (n.startsWith("::ffff:")) {
    const mapped = n.slice(7);
    // 点分十进制（::ffff:127.0.0.1）
    if (mapped.includes(".")) {
      return isPrivateIp(mapped);
    }
    // URL 解析器会把 ::ffff:127.0.0.1 规范化为 ::ffff:7f00:1（十六进制）：
    // 取末尾 32 位还原为点分十进制再判定，否则规范化形态会绕过映射检查
    let hex32 = "";
    const parts = mapped.split(":");
    if (parts.length === 1) {
      hex32 = parts[0]; // ::ffff:0a000001（单组 8 位十六进制）
    } else if (parts.length === 2) {
      hex32 = parts.map((p) => p.padStart(4, "0")).join(""); // ::ffff:7f00:1
    }
    if (/^[0-9a-f]{8}$/.test(hex32)) {
      const ipv4 = [0, 2, 4, 6]
        .map((i) => parseInt(hex32.slice(i, i + 2), 16))
        .join(".");
      return isPrivateIp(ipv4);
    }
    return false;
  }
  return false;
}

/**
 * 同步校验上游 URL（hostname 字符串层面，不含 DNS）
 * 请求时校验：拦截 IP/主机名字面量直连内网（含 IPv6 变体）
 */
export function isSafeUpstreamUrl(urlStr: string): { safe: boolean; reason?: string } {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return { safe: false, reason: "URL 格式不合法" };
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    return { safe: false, reason: "URL 协议必须是 http 或 https" };
  }
  const host = normalizeHost(url.hostname);
  if (host === "localhost" || host === "0.0.0.0" || isPrivateIp(host)) {
    return { safe: false, reason: "URL 不能指向内网或本地地址" };
  }
  return { safe: true };
}
