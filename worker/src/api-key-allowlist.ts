/**
 * API Key 白名单匹配工具
 *
 * 共享层：被 Worker 全量版、Worker lite 版、Pages V1 版通过 validateApiKey 共用。
 *
 * 支持两类白名单：
 * 1. allowedIps  — CIDR 列表（IPv4/IPv6），空/null/无效表示不限制
 * 2. allowedModels — 模型 ID 列表（精确匹配，区分大小写），空/null 表示不限制
 *
 * 存储格式：JSON 字符串（避免 Prisma schema 各方言类型差异）。
 *   allowedIps:    "[\"192.168.1.0/24\", \"10.0.0.1\"]" 或 null
 *   allowedModels: "[\"gpt-4\", \"claude-3-opus\"]" 或 null
 *
 * 解析失败的降级行为：allowedIps 解析失败 → 当作"未配置"放行（保守不误杀）。
 *   原因：白名单是收紧策略；解析错误时拒绝所有请求会误杀合法流量。
 *   allowedModels 解析失败同理放行。
 *
 * IP 匹配支持单 IP（不带 / 视为 /32 或 /128）和 CIDR 段（IPv4/IPv6 自动识别）。
 */

/** 单条白名单解析后的 IP 规则（CIDR 或单 IP） */
interface IpRule {
  family: 4 | 6;
  /** 起始 IP（bigint 表示，IPv4 转 32 位、IPv6 转 128 位无符号整数） */
  start: bigint;
  /** 结束 IP（闭区间） */
  end: bigint;
}

/**
 * IPv4 字符串 → bigint。
 * 非法输入抛错由调用方捕获。
 */
function ipv4ToBigInt(ip: string): bigint {
  const parts = ip.split(".");
  if (parts.length !== 4) throw new Error(`invalid IPv4: ${ip}`);
  let result = BigInt(0);
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error(`invalid IPv4 octet: ${p}`);
    result = (result << BigInt(8)) | BigInt(n);
  }
  return result;
}

/**
 * IPv6 字符串 → bigint。
 * 支持 "::" 简写、IPv4 映射后缀（如 "::ffff:192.0.2.1"）。
 * 非法输入抛错。
 */
function ipv6ToBigInt(ip: string): bigint {
  // 处理 IPv4 映射后缀（::ffff:a.b.c.d → ::ffff:0:0 + IPv4 段）
  let s = ip.trim().toLowerCase();
  const v4MappedMatch = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4MappedMatch) {
    const v4 = BigInt.asUintN(32, ipv4ToBigInt(v4MappedMatch[1]));
    // ::ffff:0:0:<v4>，高 80 位 1 + 16 位 0 + 低 32 位 v4
    const prefix = (BigInt(1) << BigInt(80)) - (BigInt(1) << BigInt(16)); // 0xffff...ff0000 (80 个 1 + 16 个 0)
    return prefix | v4;
  }

  // 处理 :: 简写
  if (s.includes("::")) {
    const sides = s.split("::");
    if (sides.length > 2) throw new Error(`invalid IPv6: multiple :: in ${ip}`);
    const left = sides[0] ? sides[0].split(":") : [];
    const right = sides[1] ? sides[1].split(":") : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0) throw new Error(`invalid IPv6: too many groups in ${ip}`);
    const groups = [...left, ...Array(missing).fill("0"), ...right];
    s = groups.join(":");
  }

  const parts = s.split(":");
  if (parts.length !== 8) throw new Error(`invalid IPv6 group count: ${ip}`);
  let result = BigInt(0);
  for (const g of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) throw new Error(`invalid IPv6 group: ${g}`);
    result = (result << BigInt(16)) | BigInt(parseInt(g, 16));
  }
  return result;
}

/** 解析单条 IP 规则（"1.2.3.4" 或 "1.2.3.0/24" 或 "::1" 或 "fd00::/8"） */
function parseIpRule(rule: string): IpRule | null {
  const trimmed = rule.trim();
  if (!trimmed) return null;
  const slashIdx = trimmed.indexOf("/");
  let ipStr: string;
  let prefixBits: number;
  if (slashIdx === -1) {
    ipStr = trimmed;
    prefixBits = trimmed.includes(":") ? 128 : 32;
  } else {
    ipStr = trimmed.slice(0, slashIdx);
    prefixBits = parseInt(trimmed.slice(slashIdx + 1), 10);
    if (!Number.isInteger(prefixBits) || prefixBits < 0) {
      return null;
    }
  }
  const isV6 = ipStr.includes(":");
  const totalBits = isV6 ? 128 : 32;
  if (prefixBits > totalBits) return null;
  const mask = prefixBits === 0 ? BigInt(0) : ((BigInt(1) << BigInt(prefixBits)) - BigInt(1)) << BigInt(totalBits - prefixBits);
  const fullMask = (BigInt(1) << BigInt(totalBits)) - BigInt(1);
  const fullIp = isV6 ? ipv6ToBigInt(ipStr) : ipv4ToBigInt(ipStr);
  const start = fullIp & mask;
  const end = start | (fullMask ^ mask);
  return { family: isV6 ? 6 : 4, start, end };
}

/** 缓存解析后的 IP 规则，避免每请求重复 JSON.parse + CIDR 解析 */
const ipRuleCache = new Map<string, IpRule[] | "invalid">();

/**
 * 解析 allowedIps JSON 字符串为规则列表。
 * 解析失败或非法返回 null（调用方按"放行"处理）。
 */
function parseAllowedIps(raw: string | null | undefined): IpRule[] | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const cached = ipRuleCache.get(raw);
  if (cached === "invalid") return null;
  if (cached) return cached;

  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    ipRuleCache.set(raw, "invalid");
    return null;
  }
  if (!Array.isArray(arr)) {
    ipRuleCache.set(raw, "invalid");
    return null;
  }
  const rules: IpRule[] = [];
  for (const item of arr) {
    if (typeof item !== "string") continue;
    const rule = parseIpRule(item);
    if (rule) rules.push(rule);
  }
  ipRuleCache.set(raw, rules);
  return rules;
}

/** 缓存解析后的模型白名单 */
const modelListCache = new Map<string, string[] | "invalid">();

/**
 * 解析 allowedModels JSON 字符串为模型 ID 列表。
 * 解析失败或非法返回 null（调用方按"放行"处理）。
 */
function parseAllowedModels(raw: string | null | undefined): string[] | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const cached = modelListCache.get(raw);
  if (cached === "invalid") return null;
  if (cached) return cached;

  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    modelListCache.set(raw, "invalid");
    return null;
  }
  if (!Array.isArray(arr)) {
    modelListCache.set(raw, "invalid");
    return null;
  }
  const list: string[] = [];
  for (const item of arr) {
    if (typeof item === "string" && item.length > 0 && item.length <= 200) {
      list.push(item);
    }
  }
  modelListCache.set(raw, list);
  return list;
}

/**
 * IPv4 客户端 IP → bigint（用于规则匹配）
 * 非法地址返回 null。
 */
function clientIpToBigInt(ip: string): bigint | null {
  try {
    if (ip.includes(":")) return ipv6ToBigInt(ip);
    return ipv4ToBigInt(ip);
  } catch {
    return null;
  }
}

/**
 * 检查客户端 IP 是否在白名单内。
 *
 * 行为：
 * - 白名单为空（null）→ 放行
 * - 解析失败 → 放行（保守不误杀）
 * - clientIp 缺失/非法 → 不放行（拒绝未知来源）
 * - IP 家族不匹配（v4 规则匹配 v6 客户端）→ 不放行
 * - 任一规则命中 → 放行（OR 语义）
 */
export function isClientIpAllowed(
  clientIp: string | null | undefined,
  allowedIpsRaw: string | null | undefined
): boolean {
  const rules = parseAllowedIps(allowedIpsRaw);
  if (rules === null) return true;
  if (rules.length === 0) return true;
  if (!clientIp) return false;
  const ipBig = clientIpToBigInt(clientIp);
  if (ipBig === null) return false;
  const family = clientIp.includes(":") ? 6 : 4;
  for (const r of rules) {
    if (r.family !== family) continue;
    if (ipBig >= r.start && ipBig <= r.end) return true;
  }
  return false;
}

/**
 * 检查请求模型是否在白名单内。
 *
 * 行为：
 * - 白名单为空（null）→ 放行
 * - 解析失败 → 放行
 * - model 为空 → 放行（不阻断 /v1/models 这类元数据请求）
 * - 精确匹配（区分大小写）命中 → 放行
 */
export function isModelAllowed(
  requestedModel: string | null | undefined,
  allowedModelsRaw: string | null | undefined
): boolean {
  const list = parseAllowedModels(allowedModelsRaw);
  if (list === null) return true;
  if (list.length === 0) return true;
  if (!requestedModel) return true;
  return list.includes(requestedModel);
}

/** 清除白名单解析缓存（管理后台更新 allowedIps/allowedModels 后调用） */
export function resetAllowlistCache(): void {
  ipRuleCache.clear();
  modelListCache.clear();
}
