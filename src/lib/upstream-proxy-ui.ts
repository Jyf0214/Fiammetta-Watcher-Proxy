/** 出站代理前端共享模块（无服务端依赖，列表页/详情页/列表组件共用）。
 *  常量与解析语义与 src/lib/upstream-proxy.ts 保持一致——前端不直接 import 服务端模块 */

export const CONFIG_KEY = "system:upstream_proxy";
export const POOL_KEY = "system:upstream_proxy_pool";
export const HEALTH_KEY = "system:upstream_proxy_health";
export const DEFAULT_CHECK_URL = "https://cp.cloudflare.com/generate_204";
/** 旧版配置（无 groups 字段）解析时补的组名，与后端「单组」语义等价 */
export const LEGACY_GROUP_NAME = "default";
/** 健康检查间隔允许范围（分钟，与后端 PROXY_HEALTH_INTERVAL_MIN_RANGE 一致） */
export const PROXY_HEALTH_INTERVAL_RANGE = { min: 1, max: 1440 } as const;
/** 自动更新周期允许范围（分钟，1 ~ 14 天，与后端 PROXY_PULL_INTERVAL_MIN_RANGE 一致） */
export const PROXY_PULL_INTERVAL_RANGE = { min: 1, max: 20160 } as const;
/** 自动更新周期缺省值（分钟，留空使用；与后端 DEFAULT_PROXY_PULL_INTERVAL_MIN 一致） */
export const DEFAULT_PULL_INTERVAL_MIN = 60;

export interface ProxyHealthEntry {
  status: "ok" | "fail";
  latencyMs: number;
  /** unix 秒 */
  checkedAt: number;
  failCount: number;
}
export type ProxyHealthMap = Record<string, ProxyHealthEntry>;

export interface ParsedGroup {
  name: string;
  sourceUrl: string;
  urls: string[];
  /** 组启用开关：禁用组不参与拉取/健康检查/请求路由（旧配置缺省视为启用） */
  enabled: boolean;
  /** 自动更新开关（旧配置缺省视为启用） */
  autoRefresh: boolean;
  /** 自动更新周期分钟（缺省不写 = 后端默认 60） */
  refreshIntervalMin?: number;
}
export interface ParsedConfig {
  groups: ParsedGroup[];
  platformIds: string[];
  platformGroup: Record<string, string>;
  healthCheckUrl?: string;
  /** 健康检查间隔分钟（1~1440，缺省后端默认 5） */
  healthCheckIntervalMin?: number;
}

export interface GroupFormState {
  id: string;
  name: string;
  sourceUrl: string;
  urlsText: string;
  boundPlatformIds: string[];
  enabled: boolean;
  autoRefresh: boolean;
  /** 自动更新周期分钟（null = 未设置，保存时留空，后端默认 60） */
  refreshIntervalMin: number | null;
}

/** 解析代理配置（兼容旧版纯 URL 字符串 / {urls,...} / 新版 groups，与后端 parseProxyConfig 对齐） */
export function parseProxyConfig(raw: string | undefined): ParsedConfig {
  if (!raw) return { groups: [], platformIds: [], platformGroup: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }
  if (typeof parsed === "string") {
    return {
      groups: [{ name: LEGACY_GROUP_NAME, sourceUrl: "", urls: [parsed], enabled: true, autoRefresh: true }],
      platformIds: [],
      platformGroup: {},
    };
  }
  if (Array.isArray(parsed)) {
    return {
      groups: [
        {
          name: LEGACY_GROUP_NAME,
          sourceUrl: "",
          urls: parsed.filter((u): u is string => typeof u === "string"),
          enabled: true,
          autoRefresh: true,
        },
      ],
      platformIds: [],
      platformGroup: {},
    };
  }
  if (!parsed || typeof parsed !== "object") return { groups: [], platformIds: [], platformGroup: {} };

  const obj = parsed as Record<string, unknown>;
  const groups: ParsedGroup[] = (Array.isArray(obj.groups) ? obj.groups : [])
    .filter((g): g is Record<string, unknown> => !!g && typeof g === "object" && !Array.isArray(g))
    .map((g) => ({
      name: typeof g.name === "string" ? g.name.trim() : "",
      sourceUrl: typeof g.sourceUrl === "string" ? g.sourceUrl.trim() : "",
      urls: Array.isArray(g.urls) ? g.urls.filter((u): u is string => typeof u === "string") : [],
      // 缺省视为启用（旧配置无该字段）
      enabled: typeof g.enabled === "boolean" ? g.enabled : true,
      // 缺省视为启用（旧配置无该字段）
      autoRefresh: typeof g.autoRefresh === "boolean" ? g.autoRefresh : true,
      // 缺省不写字段（后端默认 60）；范围外/非整数按后端 normalizePullIntervalMin
      // 同规则视为未设置，避免 UI 展示值与后端生效值不一致
      refreshIntervalMin:
        typeof g.refreshIntervalMin === "number" &&
        Number.isInteger(g.refreshIntervalMin) &&
        g.refreshIntervalMin >= PROXY_PULL_INTERVAL_RANGE.min &&
        g.refreshIntervalMin <= PROXY_PULL_INTERVAL_RANGE.max
          ? g.refreshIntervalMin
          : undefined,
    }))
    .filter((g) => g.name.length > 0);

  // 旧版字段（顶层 urls）兼容：无 groups 时视为单组
  const legacyUrls = Array.isArray(obj.urls) ? obj.urls.filter((u): u is string => typeof u === "string") : [];
  if (groups.length === 0 && legacyUrls.length > 0) {
    groups.push({ name: LEGACY_GROUP_NAME, sourceUrl: "", urls: legacyUrls, enabled: true, autoRefresh: true });
  }

  const platformIds = Array.isArray(obj.platformIds)
    ? obj.platformIds.filter((p): p is string => typeof p === "string")
    : [];
  const platformGroup: Record<string, string> = {};
  if (obj.platformGroup && typeof obj.platformGroup === "object" && !Array.isArray(obj.platformGroup)) {
    for (const [pid, groupName] of Object.entries(obj.platformGroup as Record<string, unknown>)) {
      if (typeof groupName === "string") platformGroup[pid] = groupName;
    }
  }
  const healthCheckUrl = typeof obj.healthCheckUrl === "string" ? obj.healthCheckUrl : undefined;
  const healthCheckIntervalMin =
    typeof obj.healthCheckIntervalMin === "number" && Number.isInteger(obj.healthCheckIntervalMin)
      ? obj.healthCheckIntervalMin
      : undefined;
  return { groups, platformIds, platformGroup, healthCheckUrl, healthCheckIntervalMin };
}

/** 解析健康度记录（容忍脏数据） */
export function parseHealthMap(raw: string | undefined): ProxyHealthMap {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const map: ProxyHealthMap = {};
    for (const [url, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (e.status !== "ok" && e.status !== "fail") continue;
      map[url] = {
        status: e.status,
        latencyMs: typeof e.latencyMs === "number" ? e.latencyMs : 0,
        checkedAt: typeof e.checkedAt === "number" ? e.checkedAt : 0,
        failCount: typeof e.failCount === "number" ? e.failCount : 0,
      };
    }
    return map;
  } catch {
    return {};
  }
}

/** 解析拉取结果（{ groupName: [url] }，容忍脏数据） */
export function parsePoolMap(raw: string | undefined): Record<string, string[]> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const map: Record<string, string[]> = {};
    for (const [groupName, urls] of Object.entries(parsed)) {
      if (Array.isArray(urls)) {
        map[groupName] = urls.filter((u): u is string => typeof u === "string");
      }
    }
    return map;
  } catch {
    return {};
  }
}

/** 手动代理文本 → 地址数组（按行拆分、去空去重） */
export function parseUrlsText(text: string): string[] {
  return [...new Set(text.split("\n").map((s) => s.trim()).filter(Boolean))];
}

/** 展示用规范化：裸 host:port 补 http://，与后端 normalizeProxyLine 写入健康表的键对齐 */
export function normalizeProxyUrl(u: string): string {
  return /^(https?|socks[45]):\/\//i.test(u) ? u : `http://${u}`;
}

/** 单行代理地址是否合法（与后端 normalizeProxyLine 语义一致）：带协议头的必须
 *  http/https/socks4/socks5，无协议头视为裸 host:port 自动补 http://；
 *  解析失败（无 host、端口非法等）拒绝 */
export function isProxyLineValid(line: string): boolean {
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(line);
  if (hasScheme && !/^(https?|socks[45]):\/\//i.test(line)) return false;
  try {
    const parsed = new URL(hasScheme ? line : `http://${line}`);
    return /^(https?|socks[45]):$/.test(parsed.protocol) && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

/** 展示用代理地址脱敏：剥离 URL 中的 user:pass 凭据（健康列表仅展示，匹配仍用完整 URL）。
 *  用正则而非 URL 序列化，避免剥离后补尾斜杠导致展示与真实地址不一致 */
export function maskProxyUrl(url: string): string {
  return url.replace(/\/\/[^@\s]+@/, "//***@");
}

/** 统计聚合键：去凭据 host:port（与后端落库/聚合键 normalizeProxyStatKey 同实现，
 *  保证查表一致）。同 host:port 不同凭据共享同一键；默认端口按协议归一化
 *  （http→80、https→443、socks→1080）；解析失败回退脱敏 */
export function normalizeProxyStatKey(url: string): string {
  try {
    // 兼容无协议前缀的裸 host:port（历史脱敏键等），补 http:// 解析
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
    const parsed = new URL(hasScheme ? url : `http://${url}`);
    const defaultPort =
      parsed.protocol === "https:" ? 443 : parsed.protocol === "http:" ? 80 : 1080;
    return `${parsed.hostname}:${parsed.port || defaultPort}`;
  } catch {
    return maskProxyUrl(url);
  }
}

/** 健康检查时间展示：unix 秒 → 「MM-DD HH:mm」（本地时区） */
export function formatChecked(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 组内全部候选地址（拉取结果 ∪ 手动代理，规范化 + 去重，供展示与健康查询共用） */
export function collectGroupUrls(poolUrls: string[], manualUrls: string[]): string[] {
  return [...new Set([...poolUrls, ...manualUrls].map(normalizeProxyUrl))];
}

/** 兼容后端两种错误形状：{ error: "msg" } 或 { error: { message } } */
export function errMsg(data: Record<string, any>, fallback: string): string {
  return typeof data.error === "string" ? data.error : data.error?.message ?? fallback;
}

/** 配置校验错误 → i18n 键 */
export type ConfigValidationError =
  | "upstreamProxyGroupNameRequired"
  | "upstreamProxyGroupNameDup"
  | "upstreamProxyGroupNameReserved"
  | "upstreamProxyInvalidSourceUrl"
  | "upstreamProxyInvalidUrls"
  | "upstreamProxyInvalidInterval"
  | "upstreamProxyInvalidRefreshInterval";

/**
 * 表单 → 配置 JSON 字符串（全空返回 "{}"；供保存与「已保存一致性」校验共用）。
 * 纯函数：校验失败返回错误键，由调用方提示
 */
export function buildConfigJson(
  groups: GroupFormState[],
  platformIds: string[],
  checkUrl: string,
  healthIntervalMin: number | null | undefined
): { ok: true; value: string } | { ok: false; error: ConfigValidationError } {
  // 健康检查间隔：允许范围内的整数；留空不写字段（后端默认 5）
  let interval: number | undefined;
  if (healthIntervalMin !== null && healthIntervalMin !== undefined) {
    if (
      !Number.isInteger(healthIntervalMin) ||
      healthIntervalMin < PROXY_HEALTH_INTERVAL_RANGE.min ||
      healthIntervalMin > PROXY_HEALTH_INTERVAL_RANGE.max
    ) {
      return { ok: false, error: "upstreamProxyInvalidInterval" };
    }
    interval = healthIntervalMin;
  }

  // 自动更新周期：允许范围内的整数；留空不写字段（后端默认 60）
  for (const g of groups) {
    if (g.refreshIntervalMin !== null && g.refreshIntervalMin !== undefined) {
      if (
        !Number.isInteger(g.refreshIntervalMin) ||
        g.refreshIntervalMin < PROXY_PULL_INTERVAL_RANGE.min ||
        g.refreshIntervalMin > PROXY_PULL_INTERVAL_RANGE.max
      ) {
        return { ok: false, error: "upstreamProxyInvalidRefreshInterval" };
      }
    }
  }

  const trimmed = groups
    .map((g) => ({
      name: g.name.trim(),
      sourceUrl: g.sourceUrl.trim(),
      urls: parseUrlsText(g.urlsText),
      boundPlatformIds: [...new Set(g.boundPlatformIds)],
      enabled: g.enabled,
      autoRefresh: g.autoRefresh,
      refreshIntervalMin: g.refreshIntervalMin,
    }))
    .filter(
      (g) =>
        g.name.length > 0 || g.sourceUrl.length > 0 || g.urls.length > 0 || g.boundPlatformIds.length > 0
    );
  if (trimmed.length === 0 && interval === undefined) return { ok: true, value: "{}" };

  // 校验组名：必填且唯一；"new" 保留给新建页路由，禁止作为组名
  const names = trimmed.map((g) => g.name);
  if (names.some((n) => !n)) return { ok: false, error: "upstreamProxyGroupNameRequired" };
  if (new Set(names).size !== names.length) return { ok: false, error: "upstreamProxyGroupNameDup" };
  if (names.some((n) => n === "new")) return { ok: false, error: "upstreamProxyGroupNameReserved" };
  // 校验拉取地址与手动代理
  for (const g of trimmed) {
    if (g.sourceUrl && !/^https?:\/\//i.test(g.sourceUrl)) {
      return { ok: false, error: "upstreamProxyInvalidSourceUrl" };
    }
    if (g.urls.some((u) => !isProxyLineValid(u))) {
      return { ok: false, error: "upstreamProxyInvalidUrls" };
    }
  }

  const platformGroup: Record<string, string> = {};
  for (const g of trimmed) {
    for (const pid of [...new Set(g.boundPlatformIds)]) platformGroup[pid] = g.name;
  }
  const checkUrlTrimmed = checkUrl.trim();
  if (checkUrlTrimmed && !/^https?:\/\//i.test(checkUrlTrimmed)) {
    return { ok: false, error: "upstreamProxyInvalidUrls" };
  }
  return {
    ok: true,
    value: JSON.stringify({
      groups: trimmed.map((g) => ({
        name: g.name,
        // 显式写 enabled/autoRefresh（与 parseProxyConfig 读取对称，保证「已保存
        // 一致性」比较成立；旧配置无该字段保存后补齐，语义不变）
        enabled: g.enabled,
        autoRefresh: g.autoRefresh,
        // 留空时不写字段，由后端 normalizeConfig 填充默认周期 60（与后端默认值
        // 保持单一来源）
        ...(g.refreshIntervalMin !== null && g.refreshIntervalMin !== undefined
          ? { refreshIntervalMin: g.refreshIntervalMin }
          : {}),
        ...(g.sourceUrl ? { sourceUrl: g.sourceUrl } : {}),
        ...(g.urls.length > 0 ? { urls: g.urls } : {}),
      })),
      platformIds,
      platformGroup,
      // 留空时不写字段，由后端 normalizeConfig 填充默认探测地址（与后端默认值保持单一来源）
      ...(checkUrlTrimmed ? { healthCheckUrl: checkUrlTrimmed } : {}),
      // 留空时不写字段，后端默认 5 分钟（与后端默认值保持单一来源）
      ...(interval !== undefined ? { healthCheckIntervalMin: interval } : {}),
    }),
  };
}

/**
 * 组内代理按归一化统计键去重求和：同 host:port 不同凭据的代理在日志聚合中共享
 * 同一统计键（落库统一 normalizeProxyStatKey），逐代理累加会把同一条统计重复计入，
 * 组级聚合翻倍——每个统计键只计一次
 */
export function sumMaskedStats<T>(
  urls: string[],
  rows: Record<string, T> | null | undefined,
  pick: (entry: T | undefined) => number
): number {
  const seen = new Set<string>();
  let total = 0;
  for (const u of urls) {
    const key = normalizeProxyStatKey(u);
    if (seen.has(key)) continue;
    seen.add(key);
    total += pick(rows?.[key]);
  }
  return total;
}