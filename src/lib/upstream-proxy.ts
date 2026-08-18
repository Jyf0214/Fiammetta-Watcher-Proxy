/**
 * 出站代理 — 网关访问上游 API（OpenAI/Anthropic 等）时经代理服务器出网
 *
 * 仅 Docker 部署（DEPLOY_PLATFORM=docker，Node 运行时）可用：
 * - Node 全局 fetch（undici）默认不读取 HTTP_PROXY 等环境变量，需显式
 *   注入 dispatcher 才能走代理；
 * - 边缘运行时（Cloudflare workerd）无 undici 连接池/TCP 能力，任何平台
 *   校验先于加载，且 undici 动态 import 保证边缘构建/运行不受影响。
 *
 * 配置：configs 表 key=system:upstream_proxy，value 为 JSON：
 *   {
 *     "groups": [
 *       { "name": "g1", "sourceUrl": "https://...", "urls": ["http://127.0.0.1:7890"] }
 *     ],
 *     "platformIds": ["p1", "p2"],       // 空数组 = 所有平台经代理（勾选=白名单）
 *     "platformGroup": { "p1": "g1" },   // 平台绑定组（未绑定的白名单平台走默认组=第一组）
 *     "healthCheckUrl": "https://...",   // 可选，默认公网探测地址
 *     "healthCheckIntervalMin": 5        // 可选，健康检查间隔分钟（1~60，默认 5）
 *   }
 * 兼容旧版纯 URL 字符串 / { urls, platformIds, healthCheckUrl } 格式
 * （无 groups 时视为单组，行为与旧版一致）。
 *
 * 拉取：带 sourceUrl 的组由 cron proxy-pull（或管理页手动）定时从该地址
 * 拉取代理列表（每行一个，兼容裸 host:port 与 http(s):// 前缀），结果存入
 * configs 表 key=system:upstream_proxy_pool（{ groupName: [url, ...] }）。
 * 拉取后状态同步：两次拉取交集内的代理保留健康度记录并恢复「在池」
 * （健康表 status 切换为 ok、清除进程内黑名单）；被移除的代理连健康
 * 记录一起清理。
 *
 * 健康度：configs 表 key=system:upstream_proxy_health 存每个代理的最近
 * 检查结果（cron proxy-health 定时 + 管理页手动触发）；业务请求网络层
 * 连续失败达阈值（markProxyFailure）的代理会被临时跳过轮询，健康检查
 * 成功时恢复。
 *
 * 路由选择：组内按「可用性 × 延迟」平滑加权轮询（见 getUpstreamProxy）。
 * 可用性数据来自业务流量统计（recordProxyTraffic 每次请求回记 2xx/429/
 * 其他失败，进程内滑动窗口），成功率接近 100% 的代理分得大部分请求，
 * 持续 429/错误的代理仅保留极小份额，错误率超阈值的代理直接排除。
 */

import { createDb, type Database } from "@/lib/prisma";
import type { WorkerEnv } from "../../worker/src/config";

// type-only import：打包期擦除，边缘运行时（workerd）不加载 undici 实现
import type { Dispatcher } from "undici";

/** 配置键：configs 表中存储的代理服务器配置（JSON 或旧版纯 URL） */
export const UPSTREAM_PROXY_CONFIG_KEY = "system:upstream_proxy";
/** 拉取结果键：{ groupName: [代理地址] } */
export const UPSTREAM_PROXY_POOL_KEY = "system:upstream_proxy_pool";
/** 健康度记录键 */
export const UPSTREAM_PROXY_HEALTH_KEY = "system:upstream_proxy_health";
/** 默认健康检查探测地址（HTTP 204，轻量；可选国内可达的 Cloudflare 联通性端点） */
export const DEFAULT_PROXY_HEALTH_CHECK_URL = "https://cp.cloudflare.com/generate_204";
/** 默认健康检查间隔（分钟）：与调度器 proxy-health 任务默认频率一致 */
export const DEFAULT_PROXY_HEALTH_INTERVAL_MIN = 5;
/** 健康检查间隔允许范围（分钟）：调度器按该间隔生成触发时刻 */
export const PROXY_HEALTH_INTERVAL_MIN_RANGE = { min: 1, max: 60 } as const;

/**
 * 设备级禁用出站代理（环境变量 UPSTREAM_PROXY_DISABLED，仅影响当前部署实例，
 * 不写数据库、不改共享配置）：
 * - 不设置 / 空 / 其他值：正常
 * - "all"：整体禁用——业务请求直连，拉取与健康检查全部不执行（含管理页手动）
 * - "health"：仅禁用定时健康检查——调度器 proxy-health 与 cron 端点不执行，
 *   管理页手动「立即检查」仍可用（拉取不受影响）
 */
export type UpstreamProxyDisableMode = "all" | "health";

/** 读取设备级禁用模式（非法/未设置返回 null = 正常） */
export function getProxyDisableMode(): UpstreamProxyDisableMode | null {
  const mode = process.env.UPSTREAM_PROXY_DISABLED;
  return mode === "all" || mode === "health" ? mode : null;
}

/** 出站代理整体禁用（all）：业务请求、拉取、健康检查（含手动）全部失效 */
export function isUpstreamProxyDisabled(): boolean {
  return getProxyDisableMode() === "all";
}

/** 定时健康检查禁用（all 或 health）：调度器与 cron 端点不执行，手动不受影响 */
export function isScheduledProxyHealthDisabled(): boolean {
  return getProxyDisableMode() !== null;
}

/** 缓存有效期：与 request-templates 的模板缓存一致（30s + updatedAt 失效检查） */
const CACHE_TTL = 30_000;
/** 健康检查单次超时（毫秒） */
const HEALTH_CHECK_TIMEOUT_MS = 10_000;
/** 代理列表拉取单次超时（毫秒） */
const PULL_TIMEOUT_MS = 15_000;
/** 拉取响应体上限（超出视为异常源，拒绝并保留旧列表） */
const PULL_MAX_BYTES = 512 * 1024;
/** 健康检查并发上限：大代理池（数千个）下全量并发会瞬间创建数千个连接与
 *  ProxyAgent，内存暴涨导致进程崩溃；分批限制并发，结果语义不变 */
const HEALTH_CHECK_CONCURRENCY = 20;
/** 业务请求网络层连续失败达到该次数 → 该代理临时标记不可用（跳过轮询） */
export const PROXY_FAIL_THRESHOLD = 3;
/** 业务请求统计降权窗口：窗口内错误率过高的代理视为出口受限，路由时跳过（窗口滑动自动恢复） */
const STATS_DOWNGRADE_WINDOW_MS = 10 * 60_000;
/** 统计降权最少样本数：样本不足不降权（避免零星错误误伤） */
const STATS_DOWNGRADE_MIN_SAMPLES = 5;
/** 统计降权错误率阈值（429 等限流 + 其他失败占请求比例） */
const STATS_DOWNGRADE_ERROR_RATE = 0.8;
/** 业务流量窗口内成功率 → 可用性权重档位（路由分配用）：接近 100% 的代理
 *  分得大部分请求，接近降权排除线（错误率 > 0.8）的代理仅保留极小份额；
 *  成功率下限 0.2 以下与排除线衔接，档位权重跨越 40 倍，可用性主导分配 */
const AVAILABILITY_WEIGHT_TIERS: ReadonlyArray<readonly [minSuccessRate: number, weight: number]> = [
  [0.9, 8],
  [0.7, 4],
  [0.5, 2],
  [0.3, 1],
  [0.2, 0.5],
  [0, 0.2],
];
/** 无业务流量统计/样本不足的代理：未知可用性给中性档（介于 0.5 与 0.7 档之间） */
const AVAILABILITY_WEIGHT_UNKNOWN = 2;
/** 延迟权重上限（最快代理）：延迟只做微调，可用性主导分配 */
const LATENCY_WEIGHT_FASTEST = 1.25;
/** 延迟权重下限（最慢代理）：与上限合计 1.67 倍差距，避免极端延迟值把权重拉爆 */
const LATENCY_WEIGHT_SLOWEST = 0.75;

/** 代理组：一源一组（sourceUrl 可空 = 纯手动组，不参与拉取） */
export interface ProxyGroupConfig {
  name: string;
  /** 拉取源地址（空 = 不拉取） */
  sourceUrl: string;
  /** 手动代理地址（与拉取结果合并为组内候选） */
  urls: string[];
  /** 组开关：禁用组不参与拉取/健康检查/请求路由（旧配置缺省视为启用） */
  enabled: boolean;
}

export interface ProxyConfig {
  groups: ProxyGroupConfig[];
  /** 空数组 = 所有平台经代理（勾选=白名单） */
  platformIds: string[];
  /** 平台 → 组名映射（绑定后该平台固定使用指定组） */
  platformGroup: Record<string, string>;
  healthCheckUrl: string;
  /** 健康检查间隔（分钟，1~60）：调度器 proxy-health 任务按此周期触发；缺省默认 5 */
  healthCheckIntervalMin: number;
}

export interface ProxyHealthEntry {
  status: "ok" | "fail";
  latencyMs: number;
  /** unix 秒 */
  checkedAt: number;
  failCount: number;
}

export type ProxyHealthMap = Record<string, ProxyHealthEntry>;

/** 选择结果：dispatcher 供 fetch 注入；url 供调用方在网络层失败时回标记 */
export interface UpstreamProxySelection {
  dispatcher: Dispatcher | null;
  url: string | null;
}

/** 单组拉取结果（管理页展示；error 非空 = 本次拉取失败/结果为空，沿用旧列表） */
export interface ProxyPullGroupResult {
  /** 本次拉取到的代理数（沿用旧列表时为 0） */
  pulled: number;
  /** 拉取后组内总数（含手动代理） */
  total: number;
  /** 相比上次新增 */
  added: number;
  /** 相比上次移除 */
  removed: number;
  /** 两次拉取交集（健康度保留并恢复在池） */
  kept: number;
  error?: string;
}

let cachedConfig: ProxyConfig | null = null;
let cachedConfigUpdatedAt: number | null = null;
let lastConfigRefresh = 0;
let cachedPool: Record<string, string[]> | null = null;
/** pool 缓存失效信号：最近一次写入/读取的原始 value 字符串。秒级 updatedAt
 *  在同秒双保存（健康检查每批写、多次拉取同秒完成）时不变化，无法区分内容
 *  变化；以内容为信号后，同秒第二次写入（DB value 已变）必然触发重读，写失败
 *  部分落库等「DB 与缓存不一致」场景也能自愈 */
let cachedPoolValue: string | null = null;
let lastPoolRefresh = 0;
let cachedHealth: ProxyHealthMap | null = null;
/** health 缓存失效信号：同 cachedPoolValue（秒级 updatedAt 同秒双保存失效） */
let cachedHealthValue: string | null = null;
let lastHealthRefresh = 0;
/** url → ProxyAgent 池：配置集合变化时释放不再使用的代理 */
const proxyAgents = new Map<string, Dispatcher>();
/** round-robin 轮询游标（仅全部候选异常时回退轮询使用） */
let roundRobinIndex = 0;
/** 平滑加权轮询状态：url → 当前累计权重（Nginx smooth weighted round-robin，
 *  跨请求推进，保证高权重代理分得多但不连续独占、低权重代理保持均衡份额） */
const proxyWeights = new Map<string, number>();
/** 进程内连续失败计数（url → 次数） */
const proxyFailCounts = new Map<string, number>();
/** 进程内临时不可用集合（网络层连续失败达阈值，健康检查成功时清除） */
const unhealthyUrls = new Set<string>();
/** 业务请求实时统计（url → 计数）：路由动态择优用（真实流量出口可用性信号，进程内不落库） */
export interface ProxyTrafficStat {
  total: number;
  ok: number;
  err429: number;
  errOther: number;
  /** 统计窗口起点：窗口固定 10 分钟滑动（非断流重置），持续请求也按窗口周期整体重置 */
  firstAt: number;
  lastAt: number;
}
const proxyReqStats = new Map<string, ProxyTrafficStat>();
/** 全部代理异常告警节流时间戳 */
let lastAllUnhealthyWarn = 0;
/** 健康检查进行中进度（管理页轮询展示；单进程内同一时刻仅一个检查任务） */
export interface HealthCheckProgress {
  running: boolean;
  total: number;
  checked: number;
  startedAt: number;
}
let healthCheckProgress: HealthCheckProgress | null = null;
/** 进行中的检查任务 promise（互斥：并发调用复用同一任务，见 runProxyHealthCheck） */
let runningCheck: Promise<ProxyHealthMap> | null = null;
/** 健康表写串行链：拉取/健康检查/失败标记并发读改写同一行（configs 表
 *  system:upstream_proxy_health），MySQL/TiDB 下行锁排队导致 Lock wait
 *  timeout（1205）且整表覆盖丢失并发写入——进程内串行化读改写（Docker 单
 *  实例即完备；缓存由每次写入同步，锁内重读拿到的是最新已落库状态） */
let healthWriteTail: Promise<unknown> = Promise.resolve();
/** 进行中的拉取任务 promise（单飞：启动拉取/cron/管理页「立即拉取」并发时
 *  复用同一任务，避免并发拉取双写 pool 行与互相覆盖，见 pullProxyGroups） */
let pullInFlight: Promise<Record<string, ProxyPullGroupResult>> | null = null;

/** 当前健康检查进度（无进行中任务时返回空进度） */
export function getHealthCheckProgress(): HealthCheckProgress {
  return healthCheckProgress ?? { running: false, total: 0, checked: 0, startedAt: 0 };
}

/** http(s) URL 且含主机名校验（new URL 解析 + hostname 非空） */
function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return /^https?:$/.test(parsed.protocol) && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

/** 代理地址校验：http/https/socks4/socks5 之一且含主机名 */
function isValidProxyUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return /^(https?|socks[45]):$/.test(parsed.protocol) && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

/** 日志用代理地址脱敏：剥离 URL 中的 user:pass 凭据，防止凭据进入服务端日志。
 *  用正则而非 URL 序列化——URL.toString() 会给裸 host 补尾斜杠，导致脱敏键与
 *  池/健康表键不一致；[^@\s] 允许密码含 @，避免打码后泄漏剩余凭据片段。
 *  与前端 upstream-proxy-ui.ts 的展示脱敏同实现，保证统计键两侧一致 */
export function maskProxyUrl(url: string): string {
  return url.replace(/\/\/[^@\s]+@/, "//***@");
}

/** 统计聚合键：去凭据 host:port（请求日志落库与 stats 聚合统一使用）。
 *  同 host:port 不同凭据（***@host:port vs host:port）共享同一统计键，
 *  否则组级聚合翻倍；默认端口按协议归一化（http→80、https→443、socks→1080，
 *  与 getAgent 的 socks 默认端口一致）。兼容历史数据：maskProxyUrl 产生的
 *  ***@host:port 键与裸 host:port 均能解析并自动并入新键（userinfo 剥离）。
 *  解析失败回退脱敏（不泄漏凭据、键保持稳定）。与前端 upstream-proxy-ui.ts
 *  同实现，保证统计键两侧一致 */
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

/** 单行代理地址规范化：兼容裸 host:port（自动补 http://）与 http(s)/socks4/socks5://
 *  前缀；其他协议（ftp:// 等）与无 host 的行返回 null，不误补成畸形地址 */
function normalizeProxyLine(lineRaw: string): string | null {
  const line = lineRaw.trim();
  if (!line) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(line);
  if (hasScheme && !/^(https?|socks[45]):\/\//i.test(line)) return null;
  const url = hasScheme ? line : `http://${line}`;
  return isValidProxyUrl(url) ? url : null;
}

/** 校验并规范化一组手动代理地址（与旧版 urls 字段校验一致） */
function normalizeUrls(raw: unknown): string[] {
  const urls: string[] = [];
  if (!Array.isArray(raw)) return urls;
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const u = normalizeProxyLine(item);
    if (!u) {
      console.error(
        `[upstream-proxy] 不支持的代理地址（仅支持 http/https/socks4/socks5 且需含主机名），已忽略: ${maskProxyUrl(item).slice(0, 60)}`
      );
      continue;
    }
    if (!urls.includes(u)) urls.push(u);
  }
  return urls;
}

/** 解析并规范化组定义（name 必填唯一；sourceUrl 非法视为无拉取源） */
function normalizeGroups(raw: unknown, legacyUrls: string[]): ProxyGroupConfig[] {
  const groups: ProxyGroupConfig[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const g = item as Record<string, unknown>;
      const name = typeof g.name === "string" ? g.name.trim() : "";
      // "new" 是新建页路由保留组名（前端 pages/admin/upstream-proxy/[id].tsx 以
      // id==="new" 判断新建分支），仅前端校验可被 API 直连绕过：名为 "new" 的组
      // 列表可见但详情页永远命中新建分支无法编辑。服务端同步拒绝（跳过该组），
      // 与空名/重名同规则，不抛错不阻断其余组
      if (!name || name === "new" || seen.has(name)) {
        if (name === "new") {
          console.error(
            `[upstream-proxy] 组名 "new" 为保留名（新建页路由），已忽略: ${maskProxyUrl(JSON.stringify(g)).slice(0, 120)}`
          );
        }
        continue;
      }
      seen.add(name);
      const sourceUrl = typeof g.sourceUrl === "string" ? g.sourceUrl.trim() : "";
      groups.push({
        name,
        // 拉取地址同样要求 http(s) + 主机名，防止畸形源 URL 让拉取任务反复失败
        sourceUrl: isValidHttpUrl(sourceUrl) ? sourceUrl : "",
        urls: normalizeUrls(g.urls),
        // 组开关：旧配置无该字段视为启用
        enabled: typeof g.enabled === "boolean" ? g.enabled : true,
      });
    }
  }

  if (groups.length === 0) {
    // 无显式组：旧版配置（顶层 urls）视为单组，行为与旧版一致
    if (legacyUrls.length === 0) return [];
    groups.push({ name: "", sourceUrl: "", urls: legacyUrls, enabled: true });
    return groups;
  }

  // 新格式下顶层 urls（旧版字段）并入第一组，避免配置迁移丢数据
  if (legacyUrls.length > 0) {
    const first = groups[0];
    first.urls = [...new Set([...legacyUrls, ...first.urls])];
  }
  return groups;
}

/** 解析并规范化配置（兼容旧版纯 URL 字符串与 {urls,...}），无有效代理时返回 null */
function parseProxyConfig(raw: string | null | undefined): ProxyConfig | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // 旧版格式：整个 value 就是代理 URL
    parsed = trimmed;
  }

  if (typeof parsed === "string") return normalizeConfig({ urls: [parsed] });
  if (Array.isArray(parsed)) return normalizeConfig({ urls: parsed });
  if (parsed && typeof parsed === "object") return normalizeConfig(parsed as Record<string, unknown>);
  return null;
}

function normalizeConfig(input: Record<string, unknown>): ProxyConfig | null {
  const legacyUrls = normalizeUrls(input.urls);
  const groups = normalizeGroups(input.groups, legacyUrls);
  if (groups.length === 0) return null;

  const platformIds = Array.isArray(input.platformIds)
    ? [...new Set(input.platformIds.filter((p): p is string => typeof p === "string" && p.length > 0))]
    : [];

  // 平台绑定组：仅保留绑定到已存在组的映射（绑定失效时路由回退默认组）
  const groupNames = new Set(groups.map((g) => g.name));
  const platformGroup: Record<string, string> = {};
  if (input.platformGroup && typeof input.platformGroup === "object" && !Array.isArray(input.platformGroup)) {
    for (const [pid, groupName] of Object.entries(input.platformGroup as Record<string, unknown>)) {
      if (!pid || typeof groupName !== "string" || !groupNames.has(groupName)) continue;
      platformGroup[pid] = groupName;
    }
  }

  let healthCheckUrl = typeof input.healthCheckUrl === "string" ? input.healthCheckUrl.trim() : "";
  if (!isValidHttpUrl(healthCheckUrl)) healthCheckUrl = DEFAULT_PROXY_HEALTH_CHECK_URL;

  // 健康检查间隔：非法值/越界回退默认（管理页保存时已校验，此处防御脏数据）
  const rawInterval = input.healthCheckIntervalMin;
  const interval =
    typeof rawInterval === "number" &&
    Number.isInteger(rawInterval) &&
    rawInterval >= PROXY_HEALTH_INTERVAL_MIN_RANGE.min &&
    rawInterval <= PROXY_HEALTH_INTERVAL_MIN_RANGE.max
      ? rawInterval
      : DEFAULT_PROXY_HEALTH_INTERVAL_MIN;

  return { groups, platformIds, platformGroup, healthCheckUrl, healthCheckIntervalMin: interval };
}

/**
 * 当前生效的健康检查间隔（分钟）：进程内配置缓存的最新值，未加载过配置时返回默认。
 * 供 Docker 调度器 proxy-health 动态 spec 使用（readProxyConfig 每次刷新缓存时更新）
 */
export function getHealthCheckIntervalMin(): number {
  return cachedConfig?.healthCheckIntervalMin ?? DEFAULT_PROXY_HEALTH_INTERVAL_MIN;
}

/** 解析健康度记录（容忍脏数据：非法条目丢弃） */
function parseHealthMap(raw: string | null | undefined): ProxyHealthMap {
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

/** 解析拉取结果记录（容忍脏数据：组值非字符串数组的条目丢弃） */
function parsePoolMap(raw: string | null | undefined): Record<string, string[]> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const map: Record<string, string[]> = {};
    for (const [groupName, urls] of Object.entries(parsed)) {
      if (!Array.isArray(urls)) continue;
      // 用 normalizeProxyLine 校验合法性：带不支持协议头的行与无 host 的行一律丢弃
      const cleaned = [
        ...new Set(
          urls.filter((u): u is string => typeof u === "string" && normalizeProxyLine(u) !== null)
        ),
      ];
      if (cleaned.length > 0) map[groupName] = cleaned;
    }
    return map;
  } catch {
    return {};
  }
}

// ===== 缓存读写（config / pool / health）=====

/** 读取代理配置（带缓存：TTL 内先用 configs.updatedAt 做廉价失效检查，管理后台保存后立即生效） */
async function readProxyConfig(
  db: D1Database | Database,
  env?: WorkerEnv
): Promise<ProxyConfig | null> {
  const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
  const now = Date.now();

  if (lastConfigRefresh !== 0 && now - lastConfigRefresh < CACHE_TTL) {
    try {
      const meta = await prisma.configs.findFirst({
        where: { key: UPSTREAM_PROXY_CONFIG_KEY },
        select: { updatedAt: true },
      });
      // 行缺失时 meta?.updatedAt 为 undefined，需归一到 null 再比较，
      // 否则与缓存的 null 恒不等，每次调用都穿透全量读库
      if ((meta?.updatedAt ?? null) === cachedConfigUpdatedAt) return cachedConfig;
    } catch (err) {
      // 失效检查失败时退回 TTL 缓存，不阻断请求
      console.error("[upstream-proxy] 配置失效检查失败，使用缓存:", err);
      return cachedConfig;
    }
  }

  try {
    const row = await prisma.configs.findFirst({
      where: { key: UPSTREAM_PROXY_CONFIG_KEY },
      select: { value: true, updatedAt: true },
    });
    cachedConfig = parseProxyConfig(row?.value ?? null);
    cachedConfigUpdatedAt = row?.updatedAt ?? null;
  } catch (err) {
    console.error("[upstream-proxy] 读取代理配置失败:", err);
    cachedConfig = null;
    cachedConfigUpdatedAt = null;
  }
  lastConfigRefresh = now;
  return cachedConfig;
}

/** 读取拉取结果（缓存模式与配置一致；失效信号为 value 内容而非 updatedAt，
 *  见 cachedPoolValue 注释——pool 由 cron/手动高频写，秒级时间戳区分不了
 *  同秒双保存） */
async function readProxyPool(
  db: D1Database | Database,
  env?: WorkerEnv
): Promise<Record<string, string[]>> {
  const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
  const now = Date.now();

  if (lastPoolRefresh !== 0 && now - lastPoolRefresh < CACHE_TTL) {
    try {
      const meta = await prisma.configs.findFirst({
        where: { key: UPSTREAM_PROXY_POOL_KEY },
        select: { value: true },
      });
      // 行缺失时 meta?.value 为 undefined，归一到 null 再比较（同 readProxyConfig）
      if ((meta?.value ?? null) === cachedPoolValue) return cachedPool ?? {};
    } catch (err) {
      console.error("[upstream-proxy] 拉取结果失效检查失败，使用缓存:", err);
      return cachedPool ?? {};
    }
  }

  try {
    const row = await prisma.configs.findFirst({
      where: { key: UPSTREAM_PROXY_POOL_KEY },
      select: { value: true },
    });
    cachedPool = parsePoolMap(row?.value ?? null);
    cachedPoolValue = row?.value ?? null;
  } catch (err) {
    console.error("[upstream-proxy] 读取拉取结果失败:", err);
    cachedPool = null;
    cachedPoolValue = null;
  }
  lastPoolRefresh = now;
  return cachedPool ?? {};
}

/** 写入拉取结果并同步内存缓存 */
async function writeProxyPool(
  db: D1Database | Database,
  env: WorkerEnv | undefined,
  pool: Record<string, string[]>
): Promise<void> {
  const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
  const now = Math.floor(Date.now() / 1000);
  const value = JSON.stringify(pool);
  await prisma.configs.upsert({
    where: { key: UPSTREAM_PROXY_POOL_KEY },
    create: {
      id: crypto.randomUUID(),
      key: UPSTREAM_PROXY_POOL_KEY,
      value,
      updatedAt: now,
    },
    update: { value, updatedAt: now },
  });
  cachedPool = pool;
  cachedPoolValue = value;
}

/** 读取健康度记录（缓存模式与配置一致；失效信号为 value 内容而非 updatedAt，
 *  同 readProxyPool——健康表由健康检查每批/失败标记高频写，秒级时间戳区分
 *  不了同秒双保存） */
async function readProxyHealth(
  db: D1Database | Database,
  env?: WorkerEnv
): Promise<ProxyHealthMap> {
  const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
  const now = Date.now();

  if (lastHealthRefresh !== 0 && now - lastHealthRefresh < CACHE_TTL) {
    try {
      const meta = await prisma.configs.findFirst({
        where: { key: UPSTREAM_PROXY_HEALTH_KEY },
        select: { value: true },
      });
      // 行缺失时 meta?.value 为 undefined，归一到 null 再比较（同 readProxyConfig）
      if ((meta?.value ?? null) === cachedHealthValue) return cachedHealth ?? {};
    } catch (err) {
      console.error("[upstream-proxy] 健康度失效检查失败，使用缓存:", err);
      return cachedHealth ?? {};
    }
  }

  try {
    const row = await prisma.configs.findFirst({
      where: { key: UPSTREAM_PROXY_HEALTH_KEY },
      select: { value: true },
    });
    cachedHealth = parseHealthMap(row?.value ?? null);
    cachedHealthValue = row?.value ?? null;
  } catch (err) {
    console.error("[upstream-proxy] 读取健康度失败:", err);
    cachedHealth = null;
    cachedHealthValue = null;
  }
  lastHealthRefresh = now;
  return cachedHealth ?? {};
}

/** 写入健康度记录并同步内存缓存 */
async function writeProxyHealth(
  db: D1Database | Database,
  env: WorkerEnv | undefined,
  map: ProxyHealthMap
): Promise<void> {
  const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
  const now = Math.floor(Date.now() / 1000);
  const value = JSON.stringify(map);
  await prisma.configs.upsert({
    where: { key: UPSTREAM_PROXY_HEALTH_KEY },
    create: {
      id: crypto.randomUUID(),
      key: UPSTREAM_PROXY_HEALTH_KEY,
      value,
      updatedAt: now,
    },
    update: { value, updatedAt: now },
  });
  cachedHealth = map;
  cachedHealthValue = value;
}

/**
 * 健康表写锁内执行读改写：串行化「读整表 → 修改 → 写整表」，杜绝并发
 * upsert 同一行的行锁竞争（TiDB Error 1205），并让后写者基于最新已落库
 * 状态合并（此前各路径用各自读取时刻的旧快照整表覆盖，会丢并发写入）。
 * 调用方在 mutate 内只改需要变的条目，其余条目原样保留。
 * 锁为进程内互斥（Docker 单实例即完备）：mutate 内不得再调用
 * withHealthLock（会确定性死锁）；多实例部署需外部互斥。
 * 读入的是深拷贝：mutate 修改不会污染模块缓存，写失败时缓存保持上次
 * 已提交状态（否则幻影修改会在下一次成功写时被持久化）
 */
async function withHealthLock<T>(
  db: D1Database | Database,
  env: WorkerEnv | undefined,
  mutate: (map: ProxyHealthMap) => T | Promise<T>
): Promise<T> {
  const run = async (): Promise<T> => {
    // 健康表条目为纯 JSON 数据，JSON 深拷贝安全（条目无函数/undefined/Date）
    const map: ProxyHealthMap = JSON.parse(JSON.stringify(await readProxyHealth(db, env)));
    const result = await mutate(map);
    await writeProxyHealth(db, env, map);
    return result;
  };
  const p = healthWriteTail.then(run, run);
  healthWriteTail = p.catch(() => undefined);
  return p;
}

// ===== ProxyAgent 池 =====

/**
 * 获取/创建 url 对应的 dispatcher（池化复用）。
 * http/https 代理用 undici ProxyAgent；socks4/socks5 代理用 fetch-socks
 * socksDispatcher（undici Agent 子类，经 socks 连接后转发 HTTP 流量）。
 * 两者都实现 undici Dispatcher 接口，请求路径统一传 fetch 的 dispatcher 选项
 */
async function getAgent(url: string): Promise<Dispatcher> {
  let agent = proxyAgents.get(url);
  if (!agent) {
    if (/^socks[45]:\/\//i.test(url)) {
      const { socksDispatcher } = await import("fetch-socks");
      const parsed = new URL(url);
      // WHATWG URL 对 userinfo 中畸形百分号序列不报错原样保留，decodeURIComponent
      // 会抛 URIError 使请求 500 且该代理无法被黑名单机制标记——解码失败回退原值
      const decodeSafe = (s: string) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      };
      // hostname 对 IPv6 字面量保留方括号（[::1]），socks 库需裸地址
      const host = parsed.hostname.replace(/^\[|\]$/g, "");
      const proxies = [
        {
          type: parsed.protocol === "socks4:" ? (4 as const) : (5 as const),
          host,
          port: Number(parsed.port || 1080),
          ...(parsed.username ? { userId: decodeSafe(parsed.username) } : {}),
          ...(parsed.password ? { password: decodeSafe(parsed.password) } : {}),
        },
      ];
      agent = socksDispatcher(proxies) as unknown as Dispatcher;
    } else {
      const { ProxyAgent } = await import("undici");
      agent = new ProxyAgent(url);
    }
    // 并发创建竞态：另一请求可能已抢先注册同一 url（await import 是异步点），
    // 丢弃本实例避免孤儿代理泄漏
    const existing = proxyAgents.get(url);
    if (existing) {
      void agent.close().catch(() => {});
      return existing;
    }
    proxyAgents.set(url, agent);
  }
  return agent;
}

/**
 * 释放配置中已不存在的代理（配置变更/清空时回收连接）。
 * close 为 fire-and-forget：undici close 会等待在途请求完成（最长超时），
 * 请求路径上 await 会阻塞后续请求；先 delete 再 close，避免复用正在关闭的实例
 */
async function releaseStaleAgents(keepUrls: Set<string>): Promise<void> {
  for (const [url, agent] of proxyAgents) {
    if (!keepUrls.has(url)) {
      proxyAgents.delete(url);
      // 同步清理进程内状态，避免 URL 重新加入配置时带着旧黑名单/旧计数
      unhealthyUrls.delete(url);
      proxyFailCounts.delete(url);
      proxyReqStats.delete(url);
      proxyWeights.delete(url);
      void agent.close().catch(() => {});
    }
  }
}

/** 上次执行代理池清理时的配置/池引用：引用变化（重载/更新）才真正遍历清理 */
let lastAgentSyncConfig: ProxyConfig | null = null;
let lastAgentSyncPool: Record<string, string[]> | null = null;

/**
 * 仅在配置/池重载（引用变化）时执行代理池清理，热路径（每请求）上引用未变
 * 时零开销跳过——代理集合只随配置保存/拉取变化，逐请求全量遍历纯属浪费。
 * 引用比较依赖 readProxyPool 的模块级缓存：DB updatedAt 未变时返回同一引用，
 * 写入路径总是赋新对象，引用变化即内容变化。
 */
async function syncStaleAgentsOnce(
  config: ProxyConfig | null,
  pool: Record<string, string[]> | null
): Promise<void> {
  if (config === lastAgentSyncConfig && pool === lastAgentSyncPool) return;
  lastAgentSyncConfig = config;
  lastAgentSyncPool = pool;
  await releaseStaleAgents(new Set(config ? collectAllGroupUrls(config, pool ?? {}) : []));
}

/** 单个代理的健康探测（成功 = 通过代理请求探测地址得到 ok 响应） */
async function checkOneProxy(
  url: string,
  healthCheckUrl: string
): Promise<{ ok: boolean; latencyMs: number }> {
  const agent = await getAgent(url);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  const start = Date.now();
  try {
    // dispatcher 是 undici 扩展字段，标准 RequestInit 无此属性（worker 类型同），
    // 用交叉类型声明避免对象字面量多余属性检查
    const init: RequestInit & { dispatcher?: Dispatcher } = {
      dispatcher: agent,
      signal: controller.signal,
      redirect: "follow",
    };
    const res = await fetch(healthCheckUrl, init);
    // 延迟以响应头到达为准（TTFB）：fetch resolve 即链路连通，业务请求同样以
    // 响应头为延迟基准；body 读取耗时不计入，避免响应体挂起把延迟顶到超时值
    const latencyMs = Date.now() - start;
    // 必须消费响应体：未读取的 body 会使 undici 连接保持占用（keep-alive 不复用），
    // 健康检查每轮对每个代理泄漏一个连接，fd/内存耗尽导致进程崩溃（无日志）。
    // mock/异常响应可能没有 arrayBuffer（测试 stub 返回 { ok, status }），跳过读取
    if (typeof res.arrayBuffer === "function") {
      try {
        await res.arrayBuffer();
      } catch {
        // body 未完整接收（挂满超时被 abort / 连接中断）：响应头虽到但响应不完整
        // 是链路异常（如代理转发丢结束标记），判失败而非正常；能取消则取消，
        // 避免连接滞留
        await res.body?.cancel().catch(() => {});
        return { ok: false, latencyMs };
      }
    }
    return { ok: res.ok, latencyMs };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timeoutId);
  }
}

/** 收集全部组的代理候选（拉取结果 ∪ 手动代理，去重）——禁用组不收集，
 *  其代理连接由 releaseStaleAgents 按 keepUrls 集合回收 */
function collectAllGroupUrls(config: ProxyConfig, pool: Record<string, string[]>): string[] {
  const urls = new Set<string>();
  for (const group of config.groups) {
    if (!group.enabled) continue;
    for (const u of group.urls) urls.add(u);
    for (const u of pool[group.name] ?? []) urls.add(u);
  }
  return [...urls];
}

/** 目标组选择：平台绑定优先，未绑定走默认组（第一组）；目标组被禁用返回 undefined（调用方走直连） */
function resolveTargetGroup(config: ProxyConfig, platformId: string | undefined): ProxyGroupConfig | undefined {
  if (platformId && config.platformGroup[platformId]) {
    const bound = config.groups.find((g) => g.name === config.platformGroup[platformId]);
    if (bound) return bound.enabled ? bound : undefined;
  }
  const first = config.groups[0];
  return first?.enabled ? first : undefined;
}

// ===== 拉取 =====

/** 流式限量读取响应体，超过上限立即抛错，防止超大响应全量进内存 */
async function readLimitedText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) {
    const text = await res.text();
    if (text.length > maxBytes) throw new Error("拉取源响应过大");
    return text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  let completed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      received += value?.byteLength ?? 0;
      if (received > maxBytes) throw new Error("拉取源响应过大");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    // 异常中断（超限/读流错误）必须取消流，否则连接滞留（同未消费 body 的泄漏）
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return text + decoder.decode();
}

/** 从单个源地址拉取代理列表（每行一个，兼容裸 host:port；非法行忽略） */
async function pullOneSource(sourceUrl: string): Promise<string[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PULL_TIMEOUT_MS);
  try {
    const res = await fetch(sourceUrl, { signal: controller.signal, redirect: "follow" });
    if (!res.ok) {
      // 消费响应体释放连接（同 checkOneProxy：未读 body 挂起 keep-alive 连接，
      // 定时拉取每轮对失效源泄漏一个连接）
      try {
        await res.arrayBuffer();
      } catch {
        await res.body?.cancel().catch(() => {});
      }
      throw new Error(`拉取源返回 HTTP ${res.status}`);
    }
    const text = await readLimitedText(res, PULL_MAX_BYTES);
    const urls: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const u = normalizeProxyLine(line);
      if (u && !urls.includes(u)) urls.push(u);
    }
    return urls;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 拉取各组的代理列表（cron proxy-pull 与管理页「立即拉取」共用）
 *
 * 状态同步（以最新拉取列表为准）：
 * - 交集（两次拉取都有）：健康表记录保留（status 切换为 ok = 恢复在池，
 *   failCount/延迟等历史保留），进程内黑名单/计数清除；
 * - 新增：不写健康表，由健康检查任务探测后记录；
 * - 移除：健康表记录、进程内黑名单、ProxyAgent 连接一并清理；
 * - 拉取失败或结果为空：沿用旧列表（避免源短暂异常清空代理池），记 error。
 */
export async function pullProxyGroups(
  db: D1Database | Database,
  env?: WorkerEnv
): Promise<Record<string, ProxyPullGroupResult>> {
  // 与 getUpstreamProxy 相同的部署/禁用门控：非 Docker 部署不创建代理/写库；
  // 环境变量整体禁用（all）时拉取同样不执行
  if (process.env.DEPLOY_PLATFORM !== "docker" || isUpstreamProxyDisabled()) return {};
  // 单飞：启动拉取/cron/管理页「立即拉取」并发时复用进行中的任务，避免并发
  // 拉取双写 pool 行（TiDB 行锁 1205）与互相覆盖（与 runningCheck 同模式）
  if (pullInFlight) return pullInFlight;

  pullInFlight = (async (): Promise<Record<string, ProxyPullGroupResult>> => {
    try {
      const config = await readProxyConfig(db, env);
      if (!config) return {};
      // 禁用组不参与拉取
      const pullGroups = config.groups.filter((g) => g.enabled && g.sourceUrl.length > 0);
      if (pullGroups.length === 0) return {};

      const prevPool = await readProxyPool(db, env);
      const nextPool: Record<string, string[]> = { ...prevPool };
      const results: Record<string, ProxyPullGroupResult> = {};
      // 跨组收集需要同步健康表的 URL，锁内统一应用（见下方 withHealthLock）
      const keptUrls = new Set<string>();
      const removedUrls = new Set<string>();

      for (const group of pullGroups) {
        const prevUrls = prevPool[group.name] ?? [];
        let fetched: string[];
        let error: string | undefined;
        try {
          fetched = await pullOneSource(group.sourceUrl);
          if (fetched.length === 0) {
            // 空结果按异常处理：保留旧列表，防止源偶发空响应清空代理池
            error = "empty";
            fetched = prevUrls;
          }
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          fetched = prevUrls;
        }
        fetched = [...new Set(fetched)];

        const total = [...new Set([...fetched, ...group.urls])].length;

        if (error) {
          // 拉取失败/空结果：沿用旧列表，且不改变任何健康状态——源故障与
          // 代理本身的连通性无关，不应误"恢复"被惩罚中的代理
          if (fetched.length > 0) nextPool[group.name] = fetched;
          else delete nextPool[group.name];
          results[group.name] = { pulled: 0, total, added: 0, removed: 0, kept: 0, error };
          continue;
        }

        const prevSet = new Set(prevUrls);
        const nextSet = new Set(fetched);
        const kept = prevUrls.filter((u) => nextSet.has(u));
        const added = fetched.filter((u) => !prevSet.has(u));
        const removed = prevUrls.filter((u) => !nextSet.has(u));

        // 交集：清除进程内黑名单与计数（健康表 status 切换 ok 在下方锁内统一
        // 应用，避免此处直接读改写整表与健康检查/失败标记并发写行锁竞争），
        // 真实连通性由后续健康检查重新判定
        for (const u of kept) {
          keptUrls.add(u);
          unhealthyUrls.delete(u);
          proxyFailCounts.set(u, 0);
        }
        // 移除：进程内状态同步清理（健康记录删除在下方锁内统一应用）
        for (const u of removed) {
          removedUrls.add(u);
          unhealthyUrls.delete(u);
          proxyFailCounts.delete(u);
          proxyReqStats.delete(u);
          proxyWeights.delete(u);
        }

        if (fetched.length > 0) nextPool[group.name] = fetched;
        else delete nextPool[group.name];
        results[group.name] = {
          pulled: added.length,
          total,
          added: added.length,
          removed: removed.length,
          kept: kept.length,
        };
      }

      // 组被删除/重命名后清理残留键，避免孤儿组池数据长期滞留
      const groupNames = new Set(config.groups.map((g) => g.name));
      for (const k of Object.keys(nextPool)) {
        if (!groupNames.has(k)) delete nextPool[k];
      }

      try {
        await writeProxyPool(db, env, nextPool);
      } catch (err) {
        console.error("[upstream-proxy] 拉取结果写入失败:", err);
      }

      // 健康表同步走写锁：交集 status 切换为 ok（最新拉取列表确认其存在 =
      // 恢复在池，failCount/延迟等历史保留，展示用）；移除的删除健康记录。
      // 纯新增（无交集/移除）或拉取失败不写健康表——不再像此前无条件重写
      // 整表，减少健康行写压力，且不会覆盖并发健康检查/失败标记的写入
      if (keptUrls.size > 0 || removedUrls.size > 0) {
        try {
          await withHealthLock(db, env, (health) => {
            for (const u of keptUrls) {
              const entry = health[u];
              if (entry) entry.status = "ok";
            }
            for (const u of removedUrls) delete health[u];
          });
        } catch (err) {
          console.error("[upstream-proxy] 拉取后健康状态写入失败:", err);
        }
      }

      // 释放被移除代理的连接（fire-and-forget close，安全）
      await releaseStaleAgents(new Set(collectAllGroupUrls(config, nextPool)));
      return results;
    } finally {
      pullInFlight = null;
    }
  })();
  return pullInFlight;
}

// ===== 请求路由 =====

/**
 * 选择出站代理（无代理配置/非 Docker 部署/平台不在白名单时返回 null）
 *
 * 组选择：平台绑定组优先；未绑定的白名单平台走默认组（第一组）。
 * 组内代理按「可用性 × 延迟」加权轮询：业务流量窗口内成功率高的代理分得
 * 大部分请求（可用性主导，40 倍档位跨度），延迟仅微调；健康度异常
 * （表记录 fail 或进程内连续失败达阈值）的代理跳过；业务流量统计窗口内
 * 错误率过高（持续 429 等出口被上游限流）的代理排除，窗口滑动自愈；
 * 延迟/统计未知时各代理权重相等退化为轮询分摊；全部异常时回退组内全部
 * 代理轮询并告警。调用方应把返回值注入上游 fetch 的 init.dispatcher
 * （undici 扩展字段），并在网络层失败时用返回的 url 调用 markProxyFailure
 * 回标记、用返回状态调用 recordProxyTraffic 回记统计。
 */

/** 业务流量窗口内成功率 → 可用性权重：样本不足视为未知（中性档）；档位
 *  覆盖成功率 0.2~1.0 共 40 倍跨度，接近降权排除线（错误率 > 0.8）的代理
 *  仅保留极小份额——可用性主导路由分配（导出供单元测试覆盖档位边界） */
export function availabilityWeight(stat: ProxyTrafficStat | undefined): number {
  if (!stat || stat.total < STATS_DOWNGRADE_MIN_SAMPLES) return AVAILABILITY_WEIGHT_UNKNOWN;
  const successRate = stat.ok / stat.total;
  for (const [minRate, weight] of AVAILABILITY_WEIGHT_TIERS) {
    if (successRate >= minRate) return weight;
  }
  return AVAILABILITY_WEIGHT_TIERS[AVAILABILITY_WEIGHT_TIERS.length - 1][1];
}

/** 延迟权重：组内相对最快延迟线性微调（最快 ×1.25 / 最慢 ×0.75，未知 ×1）——
 *  仅微调不主导；以「最快延迟/本代理延迟」的比值在上下限间插值，极端延迟
 *  值（数十倍差距）最多压到下限，不会把权重拉爆或清零 */
export function latencyWeight(latencyMs: number, minLatencyMs: number): number {
  if (latencyMs <= 0 || minLatencyMs <= 0) return 1;
  return LATENCY_WEIGHT_SLOWEST + (LATENCY_WEIGHT_FASTEST - LATENCY_WEIGHT_SLOWEST) * (minLatencyMs / latencyMs);
}

/** 平滑加权轮询（Nginx SWRR）选择：每次调用把权重累加到累计值，取累计值
 *  最大的代理并从其累计值中扣除总权重。效果：代理被选中比例 = 权重比例，
 *  且选择序列平滑——高权重代理不会连续独占（间隔分散），低权重代理周期性
 *  获得份额（不饿死）；候选集合/权重随健康与统计动态变化时旧累计值自然
 *  被新增量淹没，无需显式重置。单候选直接返回 */
function pickWeightedProxy(urls: string[], weightOf: (url: string) => number): string {
  if (urls.length === 1) return urls[0];
  let total = 0;
  let best = urls[0];
  let bestVal = -Infinity;
  for (const u of urls) {
    const weight = weightOf(u);
    const cur = (proxyWeights.get(u) ?? 0) + weight;
    proxyWeights.set(u, cur);
    total += weight;
    if (cur > bestVal) {
      bestVal = cur;
      best = u;
    }
  }
  proxyWeights.set(best, bestVal - total);
  return best;
}

export async function getUpstreamProxy(
  db: D1Database | Database,
  env?: WorkerEnv,
  platformId?: string
): Promise<UpstreamProxySelection> {
  // 仅 Docker 部署：边缘运行时（workerd）没有 undici 连接池，且代理
  // 服务器通常是容器网络内的地址，其他部署形态不适用；环境变量整体禁用
  // （all）时业务请求直连，不读配置、不建代理连接
  if (process.env.DEPLOY_PLATFORM !== "docker" || isUpstreamProxyDisabled()) return { dispatcher: null, url: null };

  const config = await readProxyConfig(db, env);
  if (!config) {
    // 配置清空：回收全部连接（仅首次/重载时执行，热路径跳过）
    await syncStaleAgentsOnce(null, null);
    return { dispatcher: null, url: null };
  }

  // 平台白名单：空列表 = 所有平台经代理；非空时仅列表内平台经代理，
  // 未传 platformId 的调用方无法判断归属，按不在名单内处理（直连）。
  // 已绑定组的平台隐含走代理（绑定本身即声明），无需重复加入白名单
  const boundGroup = platformId ? config.platformGroup[platformId] : undefined;
  if (
    config.platformIds.length > 0 &&
    !boundGroup &&
    (!platformId || !config.platformIds.includes(platformId))
  ) {
    return { dispatcher: null, url: null };
  }

  const group = resolveTargetGroup(config, platformId);
  if (!group) {
    // 目标组被禁用：返回直连，同时回收该组代理连接（keepUrls 不含禁用组）
    await syncStaleAgentsOnce(config, await readProxyPool(db, env));
    return { dispatcher: null, url: null };
  }
  const pool = await readProxyPool(db, env);
  const allUrls = collectAllGroupUrls(config, pool);
  const groupUrls = [...new Set([...group.urls, ...(pool[group.name] ?? [])])];
  if (groupUrls.length === 0) {
    // 组内无代理（如拉取尚未成功）：返回直连，同时保持代理池与其他组同步
    await syncStaleAgentsOnce(config, pool);
    return { dispatcher: null, url: null };
  }

  // 保持代理池与全部组配置集合同步（跨组复用连接）
  await syncStaleAgentsOnce(config, pool);

  const health = await readProxyHealth(db, env);
  const candidates = groupUrls.filter(
    (url) => {
      // 黑名单（连续网络层失败达阈值）直接排除；统计降权（窗口内错误率过高，
      // 如出口 IP 被上游限流）跳过，窗口滑动后自动恢复
      if (health[url]?.status === "fail" || unhealthyUrls.has(url)) return false;
      const stat = proxyReqStats.get(url);
      return stat ? !isProxyStatDegraded(stat) : true;
    }
  );
  if (candidates.length === 0) {
    // 全部候选异常（fail/黑名单/统计降权）：回退轮询保持走代理语义
    // （健康检查是周期性的，期间的临时故障不应使配置了代理的请求直接
    // 改走直连）。但回退不得无差别轮询全部代理——原实现绕过黑名单
    // （网络层连续失败达阈值）与统计降权（出口受限），坏代理永远不被
    // 排除，请求在大代理池内均匀轮转，好代理只占 1/N 概率被选中
    // （数千代理场景实测全量 fetch failed）。回退池先排除黑名单与
    // 降权两个实时业务强信号，仅保留 fail 状态（周期性探测结果可能
    // 因探测地址/时机陈旧而误伤）；全部被排除时才兜底全量轮询
    // （黑名单随健康检查成功自动清除，全黑名单是暂时状态）。
    // 告警节流到每分钟一次，避免代理持续故障期间每个请求刷日志。
    // 注意：fail 条目的 latencyMs 也是实测值（>0），延迟最优选择会
    // 固定打向最低延迟的 fail 代理，故此处强制轮询分摊
    const now = Date.now();
    if (now - lastAllUnhealthyWarn > 60_000) {
      console.warn("[upstream-proxy] 所有代理健康度异常，回退可用代理轮询");
      lastAllUnhealthyWarn = now;
    }
    const usable = groupUrls.filter((u) => {
      if (unhealthyUrls.has(u)) return false;
      const stat = proxyReqStats.get(u);
      return stat ? !isProxyStatDegraded(stat) : true;
    });
    const fallbackPool = usable.length > 0 ? usable : groupUrls;
    const fallbackUrl = fallbackPool[roundRobinIndex % fallbackPool.length];
    roundRobinIndex++;
    return { dispatcher: await getAgent(fallbackUrl), url: fallbackUrl };
  }

  // 组内加权轮询：权重 = 可用性档位 × 延迟系数。可用性（业务流量窗口内
  // 成功率，recordProxyTraffic 记录）主导分配——接近 100% 成功的代理分得
  // 大部分请求，持续 429/错误的代理（未达降权排除线）仅保留极小份额，
  // 且持续异常代理已被上方候选过滤排除；延迟只做 ±25% 微调，不再无脑
  // 固定打向最低延迟代理。平滑加权轮询保证高权重代理分得多但不连续独占、
  // 低权重代理保持均衡份额，无统计样本时各代理权重相等退化为轮询分摊。
  // 最低延迟代理连续失败仍由 markProxyFailure 黑名单自动隔离
  let minLatency = 0;
  for (const u of candidates) {
    const l = health[u]?.latencyMs ?? 0;
    if (l > 0 && (minLatency === 0 || l < minLatency)) minLatency = l;
  }
  const url = pickWeightedProxy(candidates, (u) => {
    const latency = health[u]?.latencyMs ?? 0;
    return availabilityWeight(proxyReqStats.get(u)) * latencyWeight(latency, minLatency);
  });
  return { dispatcher: await getAgent(url), url };
}

/**
 * 业务请求流量回记：路由按实时错误率动态降权（2xx 记 ok；429 记 err429；
 * 其余失败（含网络层失败 status=0）记 errOther；仅统计窗口内数据参与择优）。
 * 调用方在请求状态分派处调用，与 recordRequestLog 的 proxyUrl 透传一致
 */
export function recordProxyTraffic(url: string | undefined, status: number): void {
  if (!url) return;
  const now = Date.now();
  const prev = proxyReqStats.get(url);
  // 窗口起点固定：窗口滑过（firstAt + 10 分钟）后整体重置，持续请求下同样
  // 周期性清零——错误率始终反映最近一个窗口，旧错误基数不无限累积；
  // （此前按请求间隙断流重置：请求持续不断时计数永不重置，与文档滑窗语义不符）
  const cur =
    prev && now - prev.firstAt <= STATS_DOWNGRADE_WINDOW_MS
      ? prev
      : { total: 0, ok: 0, err429: 0, errOther: 0, firstAt: now, lastAt: now };
  cur.total += 1;
  if (status >= 200 && status < 300) cur.ok += 1;
  else if (status === 429) cur.err429 += 1;
  else cur.errOther += 1;
  cur.lastAt = now;
  proxyReqStats.set(url, cur);
}

/** 统计窗口内是否应降权：样本足够且错误率超阈值（窗口滑动自动恢复，非永久排除） */
export function isProxyStatDegraded(stat: ProxyTrafficStat): boolean {
  if (stat.total < STATS_DOWNGRADE_MIN_SAMPLES) return false;
  if (Date.now() - stat.lastAt > STATS_DOWNGRADE_WINDOW_MS) return false;
  const errRate = (stat.err429 + stat.errOther) / stat.total;
  return errRate > STATS_DOWNGRADE_ERROR_RATE;
}

/**
 * 当前处于统计降权（路由已跳过）的代理 URL 列表：供管理 stats API 暴露给前端
 * 展示降权徽标——健康点仍显示 ok 但路由已跳过，此前完全不可见
 */
export function getDegradedProxyUrls(): string[] {
  const degraded: string[] = [];
  for (const [url, stat] of proxyReqStats) {
    if (isProxyStatDegraded(stat)) degraded.push(url);
  }
  return degraded;
}

/**
 * 业务请求网络层失败回标记：连续失败达阈值的代理进入进程内黑名单
 * （跳过轮询）并写入健康度表，供管理页展示
 */
export async function markProxyFailure(
  db: D1Database | Database,
  env: WorkerEnv | undefined,
  url: string
): Promise<void> {
  // 计数始终递增（与健康检查的 failCount 语义一致）；已在黑名单内时仅维护计数，不重复写表
  const count = (proxyFailCounts.get(url) ?? 0) + 1;
  proxyFailCounts.set(url, count);
  if (count < PROXY_FAIL_THRESHOLD) return;
  if (unhealthyUrls.has(url)) return;

  unhealthyUrls.add(url);
  try {
    // 锁内读改写：多个代理同时失败时各自写整表会并发 upsert 同一行
    //（TiDB 1205）且互相覆盖——串行化后每个失败条目都基于最新表状态合并
    await withHealthLock(db, env, (health) => {
      health[url] = {
        status: "fail",
        latencyMs: 0,
        checkedAt: Math.floor(Date.now() / 1000),
        failCount: count,
      };
    });
  } catch (err) {
    console.error("[upstream-proxy] 标记代理失败状态写入失败:", err);
  }
}

/**
 * 健康检查：对每个配置的代理发起探测请求，结果写入健康度表
 * （cron proxy-health 任务与管理页「立即检查」共用）
 *
 * 并发互斥：已有检查任务时复用同一 promise（手动 POST 与 cron 并发自然
 * 串行），避免多个任务共享进度对象互相覆盖、先完成者提前复位 running。
 * 进度对象在函数入口即设置（含 startedAt），提前返回/异常由 finally 复位，
 * 前端轮询以 running=false 且 total>0 判完成、total=0 判「无候选」
 */
export async function runProxyHealthCheck(
  db: D1Database | Database,
  env?: WorkerEnv
): Promise<ProxyHealthMap> {
  // 与 getUpstreamProxy/getProxyHealth 相同的部署/禁用门控：cron 在非 Docker
  // 部署下可能残留代理配置，不应创建 ProxyAgent 或写入健康表；环境变量整体
  // 禁用（all）时手动触发同样不执行（health 模式仅定时禁用，手动仍可用）
  if (process.env.DEPLOY_PLATFORM !== "docker" || isUpstreamProxyDisabled()) return {};
  if (runningCheck) return runningCheck;

  healthCheckProgress = { running: true, total: 0, checked: 0, startedAt: Date.now() };
  runningCheck = (async (): Promise<ProxyHealthMap> => {
    try {
      const config = await readProxyConfig(db, env);
      if (!config) return {};

      const pool = await readProxyPool(db, env);
      const allUrls = collectAllGroupUrls(config, pool);
      if (allUrls.length === 0) return {};
      if (healthCheckProgress) healthCheckProgress.total = allUrls.length;

      const prev = await readProxyHealth(db, env);
      const results: ProxyHealthMap = {};

      // 分批探测：每批 HEALTH_CHECK_CONCURRENCY 个并发，批间串行。
      // 此前全量 Promise.allSettled 在导入数千代理后瞬间并发数千个 fetch +
      // 数千个 ProxyAgent，内存暴涨（实测超 200MB）导致进程崩溃（无日志）
      for (let i = 0; i < allUrls.length; i += HEALTH_CHECK_CONCURRENCY) {
        const batch = allUrls.slice(i, i + HEALTH_CHECK_CONCURRENCY);
        await Promise.allSettled(
          batch.map(async (url) => {
            const { ok, latencyMs } = await checkOneProxy(url, config.healthCheckUrl);
            const prevEntry = prev[url];
            const failCount = ok ? 0 : (prevEntry?.failCount ?? 0) + 1;
            results[url] = {
              status: ok ? "ok" : "fail",
              latencyMs,
              checkedAt: Math.floor(Date.now() / 1000),
              failCount,
            };
            if (ok) {
              // 恢复：清除进程内临时黑名单与失败计数
              unhealthyUrls.delete(url);
              proxyFailCounts.set(url, 0);
            }
          })
        );
        if (healthCheckProgress) {
          healthCheckProgress.checked = Math.min(healthCheckProgress.checked + batch.length, allUrls.length);
        }

        try {
          // 每批锁内合并写入：已检查的用本轮结果覆盖，未检查的保留当前表内
          // 最新条目——并发 markProxyFailure/拉取的写入不因本批整表覆盖丢失
          //（此前以运行开始时的快照 prev 兜底，运行期间其他路径的写入会被
          // 整表重写覆盖）；渐进写库供管理页每批刷新（进程内集合才是轮询
          // 判定的权威，表数据为展示与重启恢复）
          await withHealthLock(db, env, (health) => {
            for (const url of batch) {
              if (results[url]) health[url] = results[url];
            }
          });
        } catch (err) {
          console.error("[upstream-proxy] 健康度结果写入失败:", err);
        }
      }

      return results;
    } finally {
      // 异常/提前返回（无配置、无候选）也复位，不残留 running=true
      if (healthCheckProgress) healthCheckProgress.running = false;
      runningCheck = null;
    }
  })();
  return runningCheck;
}

/** 读取最近一次健康度结果与当前检查进度（管理页展示，非 Docker 部署或整体禁用返回空） */
export async function getProxyHealth(
  db: D1Database | Database,
  env?: WorkerEnv
): Promise<{ results: ProxyHealthMap; progress: HealthCheckProgress }> {
  if (process.env.DEPLOY_PLATFORM !== "docker" || isUpstreamProxyDisabled()) {
    return { results: {}, progress: { running: false, total: 0, checked: 0, startedAt: 0 } };
  }
  return { results: await readProxyHealth(db, env), progress: getHealthCheckProgress() };
}