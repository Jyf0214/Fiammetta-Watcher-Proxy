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
 *     "healthCheckIntervalMin": 5        // 可选，健康检查间隔分钟（1~1440，默认 5）
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
import {
  readWarpConfig,
  isWarpEffectivelyEnabled,
  isWarpProcessRunning,
} from "@/lib/upstream-proxy-warp";

// type-only import：打包期擦除，边缘运行时（workerd）不加载 undici 实现
import type { Dispatcher } from "undici";

/** 配置键：configs 表中存储的代理服务器配置（JSON 或旧版纯 URL） */
export const UPSTREAM_PROXY_CONFIG_KEY = "system:upstream_proxy";
/** 拉取结果键：{ groupName: [代理地址] } */
export const UPSTREAM_PROXY_POOL_KEY = "system:upstream_proxy_pool";
/** 健康度记录键 */
export const UPSTREAM_PROXY_HEALTH_KEY = "system:upstream_proxy_health";
/** 最近拉取时间记录键：{ groupName: 成功拉取时刻(unix 秒) }——定时拉取按组周期
 *  判定是否到期；手动「立即拉取」与容器启动拉取同样记录，周期重新计时 */
export const UPSTREAM_PROXY_PULL_AT_KEY = "system:upstream_proxy_pull_at";
/** 健康检查锁/进度键：跨实例互斥 + 进度落库（多实例下各实例进程内进度
 *  互不可见，LB 把轮询 GET 分发到非发起实例会返回残留旧进度/误判完成；
 *  锁与进度合一行，由检查实例每批 CAS 续期更新） */
export const UPSTREAM_PROXY_CHECK_LOCK_KEY = "system:upstream_proxy_check_lock";
/** 锁 TTL（秒）：每批写入进度时续期；实例崩溃残留最多 TTL 后即可被重新抢占。
 *  一轮检查数百批（每批 20 并发 × 10s 超时 ≈ 最坏 3.3 分钟/批间隔），
 *  正常完成前不会过期 */
const CHECK_LOCK_TTL_SEC = 15 * 60;
/** 拉取锁键：与健康检查独立——拉取是短时多源 HTTP 拉取（数秒~数十秒），
 *  跨实例互斥避免多实例并发拉取双写 pool 行（TiDB 1205）；TTL 短至 2 分钟
 *  即可覆盖最坏全部源超时（15s × N 源），实例崩溃残留上限可控 */
export const UPSTREAM_PROXY_PULL_LOCK_KEY = "system:upstream_proxy_pull_lock";
const PULL_LOCK_TTL_SEC = 2 * 60;
/** 默认健康检查探测地址（HTTP 204，轻量；可选国内可达的 Cloudflare 联通性端点） */
export const DEFAULT_PROXY_HEALTH_CHECK_URL = "https://cp.cloudflare.com/generate_204";
/** 默认健康检查间隔（分钟）：与调度器 proxy-health 任务默认频率一致 */
export const DEFAULT_PROXY_HEALTH_INTERVAL_MIN = 5;
/** 健康检查间隔允许范围（分钟）：上限放宽至 24 小时，低频维护场景可设长周期 */
export const PROXY_HEALTH_INTERVAL_MIN_RANGE = { min: 1, max: 1440 } as const;
/** 默认自动更新周期（分钟）：组级缺省值，与旧版定时拉取每小时触发频率一致 */
export const DEFAULT_PROXY_PULL_INTERVAL_MIN = 60;
/** 自动更新周期允许范围（分钟）：1 分钟 ~ 14 天（20160 分钟） */
export const PROXY_PULL_INTERVAL_MIN_RANGE = { min: 1, max: 20160 } as const;

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
/** 出站代理配置/池/健康缓存 TTL：代理配置极少变化，延长至 120 秒 */
const CACHE_TTL = 120_000;
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
  /** 自动更新开关：关闭后定时拉取跳过该组，手动「立即拉取」仍可用
   *  （旧配置缺省视为启用，行为与旧版一致） */
  autoRefresh: boolean;
  /** 自动更新周期（分钟，1~20160=14 天；缺省 60，与旧版每小时定时拉取频率一致） */
  refreshIntervalMin: number;
}

export interface ProxyConfig {
  groups: ProxyGroupConfig[];
  /** 空数组 = 所有平台经代理（勾选=白名单） */
  platformIds: string[];
  /** 平台 → 组名映射（绑定后该平台固定使用指定组） */
  platformGroup: Record<string, string>;
  healthCheckUrl: string;
  /** 健康检查间隔（分钟，1~1440）：调度器 proxy-health 任务按此周期触发；缺省默认 5 */
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
  /** 密钥级绑定代理全部不可用时的错误消息（仅 getUpstreamProxyForKey 返回） */
  error?: string;
}

/** 单组拉取结果（管理页展示；error 非空 = 本次拉取失败/结果为空，沿用旧列表） */
export interface ProxyPullGroupResult {
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
/** config 缓存失效信号：最近一次写入/读取的原始 value 字符串。与 pool/health
 *  同模式——秒级 updatedAt 在多实例同秒双保存（各实例进程内单调补偿互不可见，
 *  写入相同 updatedAt 甚至倒退）时不变，等值比较判定「无变化」导致其他实例
 *  最长 TTL 内继续用旧配置（禁用组仍被路由、cron 按旧代理集污染 pool/health）；
 *  以内容为信号后，任何实例写入的新值必然触发重读 */
let cachedConfigValue: string | null = null;
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

/**
 * 主动失效出站代理三态缓存（config / pool / health）
 *
 * 管理后台 PUT /api/admin/config 写入 system:upstream_proxy* 系列 key 后调用，
 * 强制本进程下一次读穿透到 DB（value 比对前置为不等则重读）。
 * 多实例下仅失效本进程；其他实例仍按 120s TTL 自然刷新。
 * 与 router.ts 的 invalidateRouterCache 同语义——出站代理配置变更后让路由层
 * 立即感知新组/平台绑定/平台白名单
 */
export function invalidateUpstreamProxyCache(): void {
  lastConfigRefresh = 0;
  lastPoolRefresh = 0;
  lastHealthRefresh = 0;
  cachedConfigValue = null;
  cachedPoolValue = null;
  cachedHealthValue = null;
}

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
 *  复用同一任务，避免并发拉取双写 pool 行与互相覆盖，见 pullProxyGroups）。
 *  手动与定时按模式分开单飞：手动模式必须拉取全部组，复用定时任务会退化为
 *  只拉到期组 */
let pullInFlight: Promise<Record<string, ProxyPullGroupResult>> | null = null;
let pullInFlightManual: Promise<Record<string, ProxyPullGroupResult>> | null = null;

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

/** 稳定短哈希（FNV-1a 32 位，8 位十六进制）：账号指纹后缀用。仅需区分性与
 *  稳定性，无需加密强度——配置表本就存凭据明文，指纹不新增泄密面 */
function hashHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** 代理级统计键：无凭据地址为 host:port（与历史日志键兼容）；带凭据地址追加
 *  账号指纹后缀 host:port#<8hex>——同 host:port 不同账号（user:pass）在统计/
 *  降权/日志中独立成键，不再合并（此前 normalizeProxyStatKey 去凭据合并导致
 *  不同账号的请求数/可用率/429 混在一起、降权互相误伤）。指纹为完整地址的
 *  确定性哈希，稳定可复现、不含凭据明文；历史已脱敏键（***@host:port）与
 *  无凭据键归入裸 host:port（历史数据无法归属具体账号）。与前端
 *  upstream-proxy-ui.ts 同实现，保证落库/聚合/查表键一致 */
export function proxyStatKey(url: string): string {
  // 幂等：已是统计键形态（host:port#<8hex>）时直接返回原值——stats 聚合与
  // 前端查表会对已落库键再次调用，若重新解析 URL，# 后的指纹会被当作
  // fragment 剥离、userinfo 为空，退回裸 host:port，导致聚合键与落库键
  // 不一致（带凭据账号统计失真/查表失配）。无 # 的历史键不命中，走归一路径
  if (/^[^/?#]+#[0-9a-f]{8}$/.test(url)) return url;
  try {
    const base = normalizeProxyStatKey(url);
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
    const parsed = new URL(hasScheme ? url : `http://${url}`);
    const userinfo = parsed.username || parsed.password;
    // 无凭据或历史脱敏键（*** 占位）→ 裸 host:port
    if (!userinfo || userinfo === "***") return base;
    return `${base}#${hashHex(url)}`;
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

/** 自动更新周期规范化：正整数且在允许范围内，否则回退默认（防御脏数据） */
function normalizePullIntervalMin(raw: unknown): number {
  return typeof raw === "number" &&
    Number.isInteger(raw) &&
    raw >= PROXY_PULL_INTERVAL_MIN_RANGE.min &&
    raw <= PROXY_PULL_INTERVAL_MIN_RANGE.max
    ? raw
    : DEFAULT_PROXY_PULL_INTERVAL_MIN;
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
        // 自动更新：旧配置无该字段视为启用（行为与旧版一致）
        autoRefresh: typeof g.autoRefresh === "boolean" ? g.autoRefresh : true,
        // 自动更新周期：非法值/越界回退默认（管理页保存时已校验，此处防御脏数据）
        refreshIntervalMin: normalizePullIntervalMin(g.refreshIntervalMin),
      });
    }
  }

  if (groups.length === 0) {
    // 无显式组：旧版配置（顶层 urls）视为单组，行为与旧版一致。
    // 组名必须与前端 LEGACY_GROUP_NAME（src/lib/upstream-proxy-ui.ts）保持一致：
    // 此前后端用 ""、前端用 "default"，用户在管理页保存一次旧格式配置后组名被
    // 重写为 "default"，与历史 pool/pullAt 键（""）失配导致已拉取代理池被清空
    if (legacyUrls.length === 0) return [];
    groups.push({
      name: "default",
      sourceUrl: "",
      urls: legacyUrls,
      enabled: true,
      autoRefresh: true,
      refreshIntervalMin: DEFAULT_PROXY_PULL_INTERVAL_MIN,
    });
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

/** 代理配置写入路径校验结果 */
export type ProxyConfigValidation = { ok: true } | { ok: false; error: string };

/**
 * 代理配置写入路径严格校验（保存前防御，与前端 buildConfigJson 校验对齐并更严）：
 * - value 必须是合法 JSON 对象/数组（兼容旧版顶层 urls 数组格式）
 * - 组名非空/唯一/非保留名 "new"；拉取地址 http(s)，手动代理 http(s)/socks4/socks5
 * - 自动更新周期与健康检查间隔整数且在允许范围
 * - platformGroup 绑定的组必须存在于 groups——保存后指向缺失组的绑定会被
 *   normalizeConfig 静默丢弃，是「绑定保存后消失」的直接来源，写入前 400 拒绝
 * 读取路径 normalizeConfig 保持宽容回退（防御存量脏数据）不变。
 */
export function validateUpstreamProxyConfig(raw: string): ProxyConfigValidation {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "配置不能为空" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "配置不是合法 JSON" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "配置必须是 JSON 对象或数组" };
  }

  const cfg = Array.isArray(parsed) ? { urls: parsed } : (parsed as Record<string, unknown>);

  // 旧版顶层 urls 数组（无 groups）：每条必须是合法代理地址
  if (cfg.urls !== undefined) {
    if (!Array.isArray(cfg.urls)) return { ok: false, error: "urls 必须是数组" };
    for (const item of cfg.urls) {
      if (typeof item !== "string" || !normalizeProxyLine(item)) {
        return {
          ok: false,
          error: `代理地址无效：${maskProxyUrl(typeof item === "string" ? item : String(item))}`,
        };
      }
    }
  }

  const groupNames = new Set<string>();
  if (cfg.groups !== undefined) {
    if (!Array.isArray(cfg.groups)) return { ok: false, error: "groups 必须是数组" };
    for (const item of cfg.groups) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return { ok: false, error: "代理组格式错误" };
      }
      const g = item as Record<string, unknown>;
      const name = typeof g.name === "string" ? g.name.trim() : "";
      if (!name) return { ok: false, error: "代理组名称不能为空" };
      if (name === "new") return { ok: false, error: `代理组名称 "${name}" 为保留名，不能使用` };
      if (groupNames.has(name)) return { ok: false, error: `代理组名称重复：${name}` };
      groupNames.add(name);

      if (g.sourceUrl !== undefined) {
        if (typeof g.sourceUrl !== "string") {
          return { ok: false, error: `代理组 "${name}" 的拉取地址格式错误` };
        }
        const sourceUrl = g.sourceUrl.trim();
        if (sourceUrl && !isValidHttpUrl(sourceUrl)) {
          return { ok: false, error: `代理组 "${name}" 的拉取地址无效：${maskProxyUrl(sourceUrl)}` };
        }
      }
      if (g.urls !== undefined) {
        if (!Array.isArray(g.urls)) return { ok: false, error: `代理组 "${name}" 的代理列表必须是数组` };
        for (const u of g.urls) {
          if (typeof u !== "string" || !normalizeProxyLine(u)) {
            return {
              ok: false,
              error: `代理组 "${name}" 的代理地址无效：${maskProxyUrl(typeof u === "string" ? u : String(u))}`,
            };
          }
        }
      }
      if (g.enabled !== undefined && typeof g.enabled !== "boolean") {
        return { ok: false, error: `代理组 "${name}" 的启用开关格式错误` };
      }
      if (g.autoRefresh !== undefined && typeof g.autoRefresh !== "boolean") {
        return { ok: false, error: `代理组 "${name}" 的自动更新开关格式错误` };
      }
      if (g.refreshIntervalMin !== undefined) {
        const v = g.refreshIntervalMin;
        if (
          typeof v !== "number" ||
          !Number.isInteger(v) ||
          v < PROXY_PULL_INTERVAL_MIN_RANGE.min ||
          v > PROXY_PULL_INTERVAL_MIN_RANGE.max
        ) {
          return {
            ok: false,
            error: `代理组 "${name}" 的自动更新周期必须在 ${PROXY_PULL_INTERVAL_MIN_RANGE.min}~${PROXY_PULL_INTERVAL_MIN_RANGE.max} 分钟之间`,
          };
        }
      }
    }
  }

  if (cfg.platformIds !== undefined) {
    if (!Array.isArray(cfg.platformIds)) return { ok: false, error: "platformIds 必须是数组" };
    for (const pid of cfg.platformIds) {
      if (typeof pid !== "string" || !pid) return { ok: false, error: "platformIds 包含无效平台 ID" };
    }
  }

  if (cfg.platformGroup !== undefined) {
    if (!cfg.platformGroup || typeof cfg.platformGroup !== "object" || Array.isArray(cfg.platformGroup)) {
      return { ok: false, error: "平台绑定格式错误" };
    }
    for (const [pid, groupName] of Object.entries(cfg.platformGroup as Record<string, unknown>)) {
      if (!pid) return { ok: false, error: "平台绑定包含无效平台 ID" };
      if (typeof groupName !== "string" || !groupNames.has(groupName)) {
        return {
          ok: false,
          error: `平台绑定指向不存在的代理组：${typeof groupName === "string" ? groupName : String(groupName)}`,
        };
      }
    }
  }

  if (cfg.healthCheckUrl !== undefined) {
    if (typeof cfg.healthCheckUrl !== "string") return { ok: false, error: "健康检查地址格式错误" };
    const url = cfg.healthCheckUrl.trim();
    if (url && !isValidHttpUrl(url)) return { ok: false, error: `健康检查地址无效：${maskProxyUrl(url)}` };
  }

  if (cfg.healthCheckIntervalMin !== undefined) {
    const v = cfg.healthCheckIntervalMin;
    if (
      typeof v !== "number" ||
      !Number.isInteger(v) ||
      v < PROXY_HEALTH_INTERVAL_MIN_RANGE.min ||
      v > PROXY_HEALTH_INTERVAL_MIN_RANGE.max
    ) {
      return {
        ok: false,
        error: `健康检查间隔必须在 ${PROXY_HEALTH_INTERVAL_MIN_RANGE.min}~${PROXY_HEALTH_INTERVAL_MIN_RANGE.max} 分钟之间`,
      };
    }
  }

  return { ok: true };
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

/** 读取代理配置（带缓存：TTL 内先用 configs.value 内容做廉价失效检查，
 *  任何实例保存后立即生效；同秒双保存/updatedAt 倒退不影响判断——
 *  见 cachedConfigValue 注释。DB 读失败时保留旧缓存并返回旧值，仅首次
 *  加载无缓存时降级为 null（直连），不会把瞬时读失败当成「配置清空」） */
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
        select: { value: true },
      });
      // 行缺失时 meta?.value 为 undefined，需归一到 null 再比较，
      // 否则与缓存的 null 恒不等，每次调用都穿透全量读库
      if ((meta?.value ?? null) === cachedConfigValue) return cachedConfig;
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
    cachedConfigValue = row?.value ?? null;
  } catch (err) {
    // 读失败保留旧缓存（不清空 cachedConfig/cachedConfigValue），返回旧值；
    // 仅首次加载无缓存时返回 null（合理降级：直连）。避免一次瞬时 DB 故障
    // 被 getUpstreamProxy 当成「配置清空」而回收全部代理连接
    console.error("[upstream-proxy] 读取代理配置失败，保留旧缓存:", err);
  }
  lastConfigRefresh = now;
  return cachedConfig;
}

/** 读取拉取结果（缓存模式与配置一致；失效信号为 value 内容而非 updatedAt，
 *  见 cachedPoolValue 注释——pool 由 cron/手动高频写，秒级时间戳区分不了
 *  同秒双保存。DB 读失败时保留旧缓存并返回旧值，仅首次加载无缓存时
 *  降级为 {}（直连）） */
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
    // 读失败保留旧缓存（不清空 cachedPool/cachedPoolValue），返回旧值；
    // 仅首次加载无缓存时返回 {}（合理降级：直连）
    console.error("[upstream-proxy] 读取拉取结果失败，保留旧缓存:", err);
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

/** 解析最近拉取时间记录（容忍脏数据：非整数的条目丢弃） */
function parsePullAtMap(raw: string | null | undefined): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const map: Record<string, number> = {};
    for (const [groupName, ts] of Object.entries(parsed)) {
      if (typeof ts === "number" && Number.isInteger(ts)) map[groupName] = ts;
    }
    return map;
  } catch {
    return {};
  }
}

/** 读取最近拉取时间记录（不缓存：定时拉取每次 tick 判定到期，直读保证
 *  多实例下看到最新写入；写入由 updatePullAtMap 进程内写链串行化） */
async function readPullAtMap(
  db: D1Database | Database,
  env?: WorkerEnv
): Promise<Record<string, number>> {
  const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
  try {
    const row = await prisma.configs.findFirst({
      where: { key: UPSTREAM_PROXY_PULL_AT_KEY },
      select: { value: true },
    });
    return parsePullAtMap(row?.value ?? null);
  } catch (err) {
    console.error("[upstream-proxy] 读取拉取时间记录失败:", err);
    return {};
  }
}

/** 更新最近拉取时间记录：进程内写链串行化「读→合并→写」（与 withHealthLock
 *  同模式），避免并发 upsert 同一行的行锁竞争（TiDB Error 1205）；多实例
 *  并发写偶发覆盖只导致下一次定时拉取提前触发一次（拉取幂等，可接受） */
let pullAtWriteTail: Promise<void> = Promise.resolve();

/** 记录拉取成功时刻（合并写入，不覆盖其他组的时间） */
async function updatePullAtMap(
  db: D1Database | Database,
  env: WorkerEnv | undefined,
  pulledAt: Record<string, number>
): Promise<void> {
  const run = async (): Promise<void> => {
    const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
    const map = await readPullAtMap(db, env);
    Object.assign(map, pulledAt);
    const now = Math.floor(Date.now() / 1000);
    const value = JSON.stringify(map);
    await prisma.configs.upsert({
      where: { key: UPSTREAM_PROXY_PULL_AT_KEY },
      create: {
        id: crypto.randomUUID(),
        key: UPSTREAM_PROXY_PULL_AT_KEY,
        value,
        updatedAt: now,
      },
      update: { value, updatedAt: now },
    });
  };
  const p = pullAtWriteTail.then(run, run);
  pullAtWriteTail = p.catch(() => undefined);
  return p;
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

/**
 * 批量读取代理三态（配置/池/健康）——热路径优化
 * 单次 findMany where key in [3] 替代 3 次串行 findFirst；
 * TTL 内先做单次 value 批量比对命中则 0 额外往返，未命中再单次拉全量。
 * 行为与三次独立 read* 完全等价：value 内容为失效信号、读失败保留旧缓存。
 */
async function readProxyStateBatch(
  db: D1Database | Database,
  env?: WorkerEnv
): Promise<{ config: ProxyConfig | null; pool: Record<string, string[]>; health: ProxyHealthMap }> {
  const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
  const now = Date.now();
  const configFresh = lastConfigRefresh !== 0 && now - lastConfigRefresh < CACHE_TTL;
  const poolFresh = lastPoolRefresh !== 0 && now - lastPoolRefresh < CACHE_TTL;
  const healthFresh = lastHealthRefresh !== 0 && now - lastHealthRefresh < CACHE_TTL;
  // 三者皆新鲜时用单次批量 value 比对（findMany 不可用时回退单键并行比对，兼容测试 mock）
  // 配置为空（null）时仅校验配置键，避免无配置场景下无谓读取健康/池表（保持原行为）
  if (configFresh && poolFresh && healthFresh) {
    try {
      const prismaAny = prisma as any;
      const needFull = cachedConfig !== null;
      if (typeof prismaAny.configs.findMany === "function") {
        const keys = needFull ? [UPSTREAM_PROXY_CONFIG_KEY, UPSTREAM_PROXY_POOL_KEY, UPSTREAM_PROXY_HEALTH_KEY] : [UPSTREAM_PROXY_CONFIG_KEY];
        const rows = await prismaAny.configs.findMany({
          where: { key: { in: keys } },
          select: { key: true, value: true },
        });
        const m = new Map(rows.map((r: any) => [r.key, r.value as string]));
        const cv = (m.get(UPSTREAM_PROXY_CONFIG_KEY) ?? null) as string | null;
        if (!needFull) {
          if ((cv ?? null) === (cachedConfigValue ?? null)) {
            return { config: cachedConfig, pool: cachedPool ?? {}, health: cachedHealth ?? {} };
          }
        } else {
          const pv = (m.get(UPSTREAM_PROXY_POOL_KEY) ?? null) as string | null;
          const hv = (m.get(UPSTREAM_PROXY_HEALTH_KEY) ?? null) as string | null;
          // 行缺失时 Map 返回 undefined，归一 null 再比对
          if ((cv ?? null) === (cachedConfigValue ?? null) && (pv ?? null) === (cachedPoolValue ?? null) && (hv ?? null) === (cachedHealthValue ?? null)) {
            return { config: cachedConfig, pool: cachedPool ?? {}, health: cachedHealth ?? {} };
          }
        }
      } else {
        // 测试 mock 仅提供 findFirst，回退并行比对（行为等价）
        if (!needFull) {
          const cr = await prismaAny.configs.findFirst({ where: { key: UPSTREAM_PROXY_CONFIG_KEY }, select: { value: true } });
          if ((cr?.value ?? null) === (cachedConfigValue ?? null)) {
            return { config: cachedConfig, pool: cachedPool ?? {}, health: cachedHealth ?? {} };
          }
        } else {
          const [cr, pr, hr] = await Promise.all([
            prismaAny.configs.findFirst({ where: { key: UPSTREAM_PROXY_CONFIG_KEY }, select: { value: true } }),
            prismaAny.configs.findFirst({ where: { key: UPSTREAM_PROXY_POOL_KEY }, select: { value: true } }),
            prismaAny.configs.findFirst({ where: { key: UPSTREAM_PROXY_HEALTH_KEY }, select: { value: true } }),
          ]);
          if ((cr?.value ?? null) === (cachedConfigValue ?? null) && (pr?.value ?? null) === (cachedPoolValue ?? null) && (hr?.value ?? null) === (cachedHealthValue ?? null)) {
            return { config: cachedConfig, pool: cachedPool ?? {}, health: cachedHealth ?? {} };
          }
        }
      }
    } catch (err) {
      console.error("[upstream-proxy] 三态批量失效检查失败，使用缓存:", err);
      return { config: cachedConfig, pool: cachedPool ?? {}, health: cachedHealth ?? {} };
    }
  }
  // 未命中批量比对：回退并行拉取（仍比串行快 3 倍），各自维护 TTL 与容错语义
  const [config, pool, health] = await Promise.all([
    readProxyConfig(db, env),
    readProxyPool(db, env),
    readProxyHealth(db, env),
  ]);
  return { config, pool, health };
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
// 缓存动态 import Promise，避免每请求一次 import 开销
let socksImportPromise: Promise<any> | null = null;
let undiciImportPromise: Promise<any> | null = null;

/**
 * Warp 兜底：组禁用 / 组无代理时尝试走 warp（容器内 warp-svc @ 127.0.0.1:40000）。
 *
 * 调用条件（全部满足）：
 * 1. process.env.DEPLOY_PLATFORM === "docker"（非 Docker 部署无 warp-cli）
 * 2. configs 表 system:upstream_proxy_warp.enabled=true + 双勾选 + 政策版本一致
 * 3. 主进程内 warp 子进程在跑（isWarpProcessRunning）
 *
 * 失败时返回 null，业务走直连（原有行为）。
 */
async function tryWarpFallback(): Promise<UpstreamProxySelection | null> {
  if (process.env.DEPLOY_PLATFORM !== "docker") return null;
  if (!isWarpProcessRunning()) return null;
  try {
    const cfg = await readWarpConfig();
    if (!cfg || !isWarpEffectivelyEnabled(cfg)) return null;
    const url = `socks5://${cfg.host}:${cfg.port}`;
    const dispatcher = await getAgent(url);
    return { dispatcher, url, error: undefined };
  } catch (err) {
    // 任何异常（含 socksDispatcher 内部失败）不阻断业务，返回 null 走直连
    console.warn(
      `[upstream-proxy] warp 兜底失败: ${(err as Error)?.message ?? String(err)}`
    );
    return null;
  }
}

async function getAgent(url: string): Promise<Dispatcher> {
  let agent: Dispatcher | undefined = proxyAgents.get(url);
  if (!agent) {
    if (/^socks[45]:\/\//i.test(url)) {
      socksImportPromise ??= import("fetch-socks");
      const { socksDispatcher } = await socksImportPromise;
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
      undiciImportPromise ??= import("undici");
      const { ProxyAgent } = await undiciImportPromise;
      agent = new ProxyAgent(url);
    }
    // 并发创建竞态：另一请求可能已抢先注册同一 url（await import 是异步点），
    // 丢弃本实例避免孤儿代理泄漏
    const existing = proxyAgents.get(url);
    if (existing) {
      void (agent as Dispatcher).close().catch(() => {});
      return existing;
    }
    proxyAgents.set(url, agent as Dispatcher);
  }
  return agent as Dispatcher;
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
 * 拉取选项：manual=true 为手动模式（管理页「立即拉取」/容器启动时），忽略
 * autoRefresh 与周期判定，拉取全部启用且有订阅地址的组；缺省为定时模式，
 * 仅拉取「自动更新开启 + 距上次成功拉取 ≥ 组周期」的组
 */
export interface PullProxyGroupsOptions {
  manual?: boolean;
}

/**
 * 拉取各组的代理列表（cron proxy-pull 与管理页「立即拉取」共用）
 *
 * 组级自动更新：定时模式按每组 autoRefresh 与 refreshIntervalMin 判定是否
 * 到期（距上次成功拉取时刻 ≥ 周期），手动模式不受开关与周期限制；成功拉取
 * 的组记录时刻（失败/空结果不记录，定时任务按周期重试；手动与定时共用同一
 * 记录，手动拉取后定时周期重新计时）。
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
  env?: WorkerEnv,
  options: PullProxyGroupsOptions = {}
): Promise<Record<string, ProxyPullGroupResult>> {
  // 与 getUpstreamProxy 相同的部署/禁用门控：非 Docker 部署不创建代理/写库；
  // 环境变量整体禁用（all）时拉取同样不执行
  if (process.env.DEPLOY_PLATFORM !== "docker" || isUpstreamProxyDisabled()) return {};
  // 单飞：同模式并发（启动拉取/cron 定时/管理页「立即拉取」各自并发）时复用
  // 进行中的任务，避免并发拉取双写 pool 行（TiDB 行锁 1205）与互相覆盖
  // （与 runningCheck 同模式）。手动与定时按模式分开单飞：手动模式要拉取
  // 全部组（绕过周期判定），若复用进行中的定时任务只会拉到「到期组」，与
  // 手动语义冲突；两模式并发双写 pool 内容幂等（同组同源拉取结果一致），
  // 且写失败有 try/catch 兜底，可接受
  if (options.manual) {
    if (pullInFlightManual) return pullInFlightManual;
  } else if (pullInFlight) {
    return pullInFlight;
  }

  let acquiredPull: { owner: string; value: string } | null = null;

  const flight = (async (): Promise<Record<string, ProxyPullGroupResult>> => {
    try {
      // 跨实例互斥（仅定时模式）：configs 表拉取锁（与健康检查锁同模式）。
      // 多实例 cron 定时拉取并发时仅一个实例执行拉取，其余实例直接返回
      // （pool 表不会被并发 upsert 触发 1205 + 各实例 fetch 重复消耗源站带宽）。
      // 手动模式不走锁——管理页「立即拉取」是用户主动行为，并发跨实例执行
      // 影响小（pool 内容幂等），且锁被 cron 持有时手动模式应绕过锁立即
      // 响应用户操作。抢锁移入 flight IIFE 内部：先赋值 pullInFlight 让
      // 同实例并发复用 Promise，避免两次抢锁（A 抢成功 + B 抢失败 → 都被
      // 算作并发拉取触发 mock 调用，但 B 抢锁失败返回 {} 破坏复用语义）
      if (!options.manual) {
        acquiredPull = await acquirePullLock(db, env);
        if (!acquiredPull) return {};
      }
      const config = await readProxyConfig(db, env);
      if (!config) return {};
      const nowSec = Math.floor(Date.now() / 1000);
      const pullAt = await readPullAtMap(db, env);
      // 定时模式：启用 + 自动更新开启 + 有订阅地址 + 距上次成功拉取 ≥ 周期；
      // 手动模式：启用 + 有订阅地址（自动更新关闭不影响手动「立即拉取」）
      const pullGroups = config.groups.filter((g) => {
        if (!g.enabled || g.sourceUrl.length === 0) return false;
        if (options.manual) return true;
        if (!g.autoRefresh) return false;
        const lastAt = pullAt[g.name] ?? 0;
        return nowSec - lastAt >= g.refreshIntervalMin * 60;
      });
      if (pullGroups.length === 0) return {};

      const prevPool = await readProxyPool(db, env);
      const nextPool: Record<string, string[]> = { ...prevPool };
      const results: Record<string, ProxyPullGroupResult> = {};
      // 本次拉取成功的组：{ groupName: 成功时刻 }，循环后统一落库
      const pulledAt: Record<string, number> = {};
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
          // 代理本身的连通性无关，不应误"恢复"被惩罚中的代理；也不记录
          // 拉取时刻，定时任务按组周期重试
          if (fetched.length > 0) nextPool[group.name] = fetched;
          else delete nextPool[group.name];
          results[group.name] = { total, added: 0, removed: 0, kept: 0, error };
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
          total,
          added: added.length,
          removed: removed.length,
          kept: kept.length,
        };
        // 拉取成功：记录时刻，定时周期从此刻重新计时
        pulledAt[group.name] = nowSec;
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

      // 记录成功拉取时刻（失败组不入 pulledAt，前面已 continue；写失败仅
      // 影响下一次定时拉取提前触发一次，拉取幂等可接受）
      if (Object.keys(pulledAt).length > 0) {
        try {
          await updatePullAtMap(db, env, pulledAt);
        } catch (err) {
          console.error("[upstream-proxy] 拉取时间记录写入失败:", err);
        }
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
      if (options.manual) pullInFlightManual = null;
      else pullInFlight = null;
    }
  })();
  if (options.manual) pullInFlightManual = flight;
  else pullInFlight = flight;
  return flight;
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

  // 热路径单次批量读取三态（TTL 命中时单次 findMany 比对，未命中并行 3 读）
  const { config, pool, health } = await readProxyStateBatch(db, env);
  if (!config) {
    // 配置未配置或首次加载失败（读失败保留旧缓存，仅首次无缓存时降级直连）：
    // 回收全部连接（仅首次/重载时执行，热路径跳过）
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
    // 目标组被禁用：先尝试 warp 兜底，未启用时直连
    const warpSel = await tryWarpFallback();
    if (warpSel) return warpSel;
    await syncStaleAgentsOnce(config, pool);
    return { dispatcher: null, url: null };
  }
  const groupUrls = [...new Set([...group.urls, ...(pool[group.name] ?? [])])];
  if (groupUrls.length === 0) {
    // 组内无代理（如拉取尚未成功）：先尝试 warp 兜底，未启用时直连
    const warpSel = await tryWarpFallback();
    if (warpSel) return warpSel;
    await syncStaleAgentsOnce(config, pool);
    return { dispatcher: null, url: null };
  }

  // 保持代理池与全部组配置集合同步（跨组复用连接）
  await syncStaleAgentsOnce(config, pool);
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
    // 注意：fail 条目中仅健康检查失败带实测延迟，业务失败标记
    // （markProxyFailure）写入 latencyMs=0——若按延迟择优仍可能固定打向
    // 最低延迟的 fail 代理（探测结果可能因探测地址/时机陈旧而误伤），
    // 故此处强制轮询分摊
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
 * 密钥级代理选择：密钥绑定了代理 URL 时优先使用，否则回退平台级
 *
 * 优先级：密钥级绑定 > 出站代理指定（platformGroup） > 平台白名单 > 默认组
 *
 * @param keyProxyUrls 密钥绑定的代理 URL 数组（从 apiKeys JSON 的 proxyUrls 字段读取）
 * @param strict 严格模式：绑定代理全部不可用时返回 error（502），否则回退平台级
 */
export async function getUpstreamProxyForKey(
  db: D1Database | Database,
  env?: WorkerEnv,
  platformId?: string,
  keyProxyUrls?: string[],
  strict?: boolean
): Promise<UpstreamProxySelection> {
  // 无密钥级绑定：回退平台级选择（完全等价于 getUpstreamProxy）
  if (!keyProxyUrls || keyProxyUrls.length === 0) {
    return getUpstreamProxy(db, env, platformId);
  }

  // 非 Docker 部署：出站代理不可用，密钥绑定同样无效
  if (process.env.DEPLOY_PLATFORM !== "docker" || isUpstreamProxyDisabled()) {
    return strict !== false
      ? { dispatcher: null, url: null, error: "出站代理不可用（非 Docker 部署或已全局禁用）" }
      : { dispatcher: null, url: null };
  }

  const { config, pool, health } = await readProxyStateBatch(db, env);
  if (!config) {
    return strict !== false
      ? { dispatcher: null, url: null, error: "出站代理配置未初始化" }
      : { dispatcher: null, url: null };
  }

  // 收集绑定代理的候选（去重 + 验证合法性）
  const seen = new Set<string>();
  const keyCandidates: string[] = [];
  for (const url of keyProxyUrls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    // 验证是否存在于当前配置的任意组内（防止绑定已删除的代理）
    const inConfig = config.groups.some(
      (g) => g.enabled && (g.urls.includes(url) || (pool[g.name] ?? []).includes(url))
    );
    if (inConfig) keyCandidates.push(url);
  }

  if (keyCandidates.length > 0) {
    // 过滤不可用代理（健康检查失败 / 网络层连续失败黑名单 / 统计降权）
    const available = keyCandidates.filter((url) => {
      if (health[url]?.status === "fail" || unhealthyUrls.has(url)) return false;
      const stat = proxyReqStats.get(url);
      return stat ? !isProxyStatDegraded(stat) : true;
    });

    if (available.length > 0) {
      // 多个可用代理时用加权轮询选一个（与平台级一致）
      let minLatency = 0;
      for (const u of available) {
        const l = health[u]?.latencyMs ?? 0;
        if (l > 0 && (minLatency === 0 || l < minLatency)) minLatency = l;
      }
      const url =
        available.length === 1
          ? available[0]
          : pickWeightedProxy(available, (u) => {
              const latency = health[u]?.latencyMs ?? 0;
              return availabilityWeight(proxyReqStats.get(u)) * latencyWeight(latency, minLatency);
            });
      return { dispatcher: await getAgent(url), url };
    }
  }

  // 绑定代理全部不可用（或不存在于配置中）
  if (strict !== false) {
    return {
      dispatcher: null,
      url: null,
      error: `密钥绑定的代理全部不可用（共 ${keyProxyUrls.length} 个）`,
    };
  }

  // 非严格模式：回退平台级代理
  return getUpstreamProxy(db, env, platformId);
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
 *
 * 多实例并发：用 updateMany where value=oldValue 做乐观锁（CAS），避免
 * 多实例各自基于不同快照 read-modify-write 整表覆盖（withHealthLock 注释
 * line 1027 已说明其仅进程内互斥，多实例需外部互斥）。CAS 失败 = 其他实例
 * 刚写入，丢弃旧快照重读最新值再合并（最多 3 次重试，防止雪崩）。
 * 进程内黑名单仅在 DB 写成功后才加入——DB 瞬时故障时不会让本实例过激
 * 跳过 url 而其他实例仍正常使用，避免「某代理持续不可用但其他实例看不到
 * 原因」的脏黑名单
 *
 * 行不存在处理：首次启用出站代理、cron 未跑过或健康表被清空时 DB 行缺失，
 * 此时 updateMany where value=oldValue 永远不匹配（count=0）；检测
 * cachedHealthValue === null 后改用 create——确保连续失败时 markProxyFailure
 * 仍能落库（unique 冲突 → 行已被其他实例 create，下次重试走 CAS 路径）
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

  const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
  const nowSec = Math.floor(Date.now() / 1000);
  for (let attempt = 0; attempt < 3; attempt++) {
    const oldHealth = await readProxyHealth(db, env);
    const newHealth: ProxyHealthMap = JSON.parse(JSON.stringify(oldHealth));
    newHealth[url] = {
      status: "fail",
      latencyMs: 0,
      checkedAt: nowSec,
      failCount: count,
    };
    const oldValue = JSON.stringify(oldHealth);
    const newValue = JSON.stringify(newHealth);
    // 行不存在（首次部署 / 健康表被清空）：cachedHealthValue 被 readProxyHealth
    // 设为 null；updateMany where value=... 永远不匹配 → 改用 create
    const isNewRow = cachedHealthValue === null;
    try {
      if (isNewRow) {
        try {
          await prisma.configs.create({
            data: {
              id: crypto.randomUUID(),
              key: UPSTREAM_PROXY_HEALTH_KEY,
              value: newValue,
              updatedAt: nowSec,
            },
          });
        } catch {
          // 行已被其他实例 create（unique 冲突）：下次重试走 CAS 路径
          continue;
        }
      } else {
        const res = await prisma.configs.updateMany({
          where: { key: UPSTREAM_PROXY_HEALTH_KEY, value: oldValue },
          data: { value: newValue, updatedAt: nowSec },
        });
        if (res.count !== 1) {
          // CAS 失败：值已被其他实例修改，下次重试基于最新快照合并
          continue;
        }
      }
      // 写成功：才把 url 加入本进程黑名单（避免写失败时的过激黑名单）
      unhealthyUrls.add(url);
      // 同步本地缓存：让本进程后续 read 命中最新 value
      cachedHealth = newHealth;
      cachedHealthValue = newValue;
      lastHealthRefresh = Date.now();
      return;
    } catch (err) {
      console.error("[upstream-proxy] 标记代理失败状态写入失败:", err);
      return;
    }
  }
  console.error(
    `[upstream-proxy] markProxyFailure CAS 失败达上限，本次失败标记丢弃: ${url}`
  );
}

/**
 * 健康检查：对每个配置的代理发起探测请求，结果写入健康度表
 * （cron proxy-health 任务与管理页「立即检查」共用）
 *
 * 并发互斥（跨实例）：configs 表租约锁（UPSTREAM_PROXY_CHECK_LOCK_KEY）
 * 原子抢占——多实例各自跑 cron/手动触发时同一时刻仅一个实例执行检查，
 * 其余返回当前健康表（锁由每批 CAS 续期，崩溃残留 TTL 后自动释放）。
 * 进程内 runningCheck 单飞保持同实例并发复用（手动 POST 与 cron 并发自然
 * 串行），避免多个任务共享进度对象互相覆盖、先完成者提前复位 running。
 * 进度对象在函数入口即设置（含 startedAt），提前返回/异常由 finally 复位，
 * 并同步落库（每批 CAS 更新），前端轮询 GET 打到任意实例读到一致的进度；
 * 以 running=false 且 total>0 判完成、total=0 判「无候选」。
 * 锁丢失（CAS 失败 = 被其他实例接管）时停止后续写入，避免污染健康表。
 */

/** 健康检查锁/进度（configs 表单行 JSON；owner 防误释放，expiresAt 兜底崩溃） */
interface CheckLock {
  owner: string;
  startedAt: number;
  expiresAt: number;
  running: boolean;
  total: number;
  checked: number;
}

/** 读取健康检查锁/进度（行缺失/解析失败返回 null） */
async function readCheckLock(
  db: D1Database | Database,
  env?: WorkerEnv
): Promise<CheckLock | null> {
  try {
    const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
    const row = await prisma.configs.findFirst({
      where: { key: UPSTREAM_PROXY_CHECK_LOCK_KEY },
      select: { value: true },
    });
    if (!row?.value) return null;
    const lock = JSON.parse(row.value) as CheckLock;
    return typeof lock.owner === "string" && typeof lock.running === "boolean" ? lock : null;
  } catch {
    return null;
  }
}

/** 构造锁 value（owner/startedAt 保留，进度字段更新，续期 expiresAt） */
function serializeLock(lock: CheckLock): string {
  return JSON.stringify(lock);
}

/**
 * 抢占健康检查锁：锁不存在/已完成（running=false）/过期时写入自己的锁并
 * 回读验证 owner——并发 upsert 由「最后写者胜 + 回读验证」兜底，始终只有
 * 一个实例成功；已被其他实例持有（running 且未过期）返回 null。
 * 返回 { owner, value }（成功）或 null（占用中）
 */
async function acquireCheckLock(
  db: D1Database | Database,
  env?: WorkerEnv
): Promise<{ owner: string; value: string } | null> {
  const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
  const existing = await readCheckLock(db, env);
  const nowSec = Math.floor(Date.now() / 1000);
  if (existing && existing.running && existing.expiresAt > nowSec) return null;

  const owner = crypto.randomUUID();
  const lock: CheckLock = {
    owner,
    startedAt: nowSec,
    expiresAt: nowSec + CHECK_LOCK_TTL_SEC,
    running: true,
    total: 0,
    checked: 0,
  };
  const value = serializeLock(lock);
  await prisma.configs.upsert({
    where: { key: UPSTREAM_PROXY_CHECK_LOCK_KEY },
    create: {
      id: crypto.randomUUID(),
      key: UPSTREAM_PROXY_CHECK_LOCK_KEY,
      value,
      updatedAt: nowSec,
    },
    update: { value, updatedAt: nowSec },
  });
  const verify = await readCheckLock(db, env);
  return verify?.owner === owner ? { owner, value } : null;
}

// ===== 拉取锁（跨实例互斥，避免多实例并发拉取双写 pool 行） =====

/** 拉取锁：仅 owner/startedAt/expiresAt，无进度——拉取是短时任务无需落库进度 */
interface PullLock {
  owner: string;
  startedAt: number;
  expiresAt: number;
}

async function readPullLock(
  db: D1Database | Database,
  env?: WorkerEnv
): Promise<PullLock | null> {
  try {
    const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
    const row = await prisma.configs.findFirst({
      where: { key: UPSTREAM_PROXY_PULL_LOCK_KEY },
      select: { value: true },
    });
    if (!row?.value) return null;
    const lock = JSON.parse(row.value) as PullLock;
    return typeof lock.owner === "string" && typeof lock.expiresAt === "number" ? lock : null;
  } catch {
    return null;
  }
}

/**
 * 抢占拉取锁：锁不存在/过期时写入自己的锁并回读验证 owner——并发 upsert
 * 由「最后写者胜 + 回读验证」兜底（与 acquireCheckLock 同模式）。已被其他
 * 实例持有且未过期时返回 null（其他实例正在拉取，本实例跳过本次拉取）。
 * 返回 { owner, value }（成功）或 null（占用中/失败）
 */
async function acquirePullLock(
  db: D1Database | Database,
  env?: WorkerEnv
): Promise<{ owner: string; value: string } | null> {
  const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
  const existing = await readPullLock(db, env);
  const nowSec = Math.floor(Date.now() / 1000);
  if (existing && existing.expiresAt > nowSec) return null;

  const owner = crypto.randomUUID();
  const lock: PullLock = {
    owner,
    startedAt: nowSec,
    expiresAt: nowSec + PULL_LOCK_TTL_SEC,
  };
  const value = JSON.stringify(lock);
  await prisma.configs.upsert({
    where: { key: UPSTREAM_PROXY_PULL_LOCK_KEY },
    create: {
      id: crypto.randomUUID(),
      key: UPSTREAM_PROXY_PULL_LOCK_KEY,
      value,
      updatedAt: nowSec,
    },
    update: { value, updatedAt: nowSec },
  });
  const verify = await readPullLock(db, env);
  return verify?.owner === owner ? { owner, value } : null;
}

/**
 * 释放拉取锁：CAS 校验 owner 后写 cleared 状态（expiresAt=0 让
 * acquirePullLock 立即可抢占）；失败 = 锁已易主（极少数极端情况：owner
 * 撞 UUID 概率近乎 0 + TTL 内多次抢占），静默忽略
 */
async function releasePullLock(
  db: D1Database | Database,
  env: WorkerEnv | undefined,
  expectedValue: string
): Promise<void> {
  try {
    const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
    await prisma.configs.updateMany({
      where: { key: UPSTREAM_PROXY_PULL_LOCK_KEY, value: expectedValue },
      data: {
        value: JSON.stringify({ owner: "", startedAt: 0, expiresAt: 0 }),
        updatedAt: Math.floor(Date.now() / 1000),
      },
    });
  } catch (err) {
    console.error("[upstream-proxy] 拉取锁释放失败:", err);
  }
}

/**
 * 锁内 CAS 更新：where value 与本地持有值精确匹配才写入（原子），
 * 防止锁被其他实例接管/释放后本实例的迟到写入覆盖新锁。
 * 返回是否更新成功；失败 = 锁已易主，调用方应停止后续写入
 */
async function casUpdateCheckLock(
  db: D1Database | Database,
  env: WorkerEnv | undefined,
  expectedValue: string,
  next: CheckLock
): Promise<boolean> {
  try {
    const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
    const res = await prisma.configs.updateMany({
      where: { key: UPSTREAM_PROXY_CHECK_LOCK_KEY, value: expectedValue },
      data: { value: serializeLock(next), updatedAt: Math.floor(Date.now() / 1000) },
    });
    return res.count === 1;
  } catch (err) {
    console.error("[upstream-proxy] 健康检查进度写入失败:", err);
    return false;
  }
}

export async function runProxyHealthCheck(
  db: D1Database | Database,
  env?: WorkerEnv
): Promise<ProxyHealthMap> {
  // 与 getUpstreamProxy/getProxyHealth 相同的部署/禁用门控：cron 在非 Docker
  // 部署下可能残留代理配置，不应创建 ProxyAgent 或写入健康表；环境变量整体
  // 禁用（all）时手动触发同样不执行（health 模式仅定时禁用，手动仍可用）
  if (process.env.DEPLOY_PLATFORM !== "docker" || isUpstreamProxyDisabled()) return {};
  if (runningCheck) return runningCheck;

  // 跨实例互斥：抢占 configs 表租约锁（多实例各自跑 cron/手动触发时仅一个
  // 实例执行检查，其余返回当前健康表；同实例并发仍由 runningCheck 单飞兜底）
  const acquired = await acquireCheckLock(db, env);
  if (!acquired) return readProxyHealth(db, env);

  const { owner, value: initialLockValue } = acquired;
  healthCheckProgress = { running: true, total: 0, checked: 0, startedAt: Date.now() };
  runningCheck = (async (): Promise<ProxyHealthMap> => {
    // 本地持锁值：CAS 更新/释放的 where 依据（锁被其他实例接管后值变化，
    // CAS 自然失败停止写入）；finally 用最终值写 running=false 释放
    let lockValue: string = initialLockValue;
    let lockState: CheckLock = {
      owner,
      startedAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + CHECK_LOCK_TTL_SEC,
      running: true,
      total: 0,
      checked: 0,
    };
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

        // 进度落库（跨实例可见）并续期锁：CAS 失败 = 锁已被其他实例接管
        //（本实例运行超 TTL/异常），停止后续写入避免污染健康表
        lockState = {
          ...lockState,
          expiresAt: Math.floor(Date.now() / 1000) + CHECK_LOCK_TTL_SEC,
          total: allUrls.length,
          checked: healthCheckProgress?.checked ?? 0,
        };
        if (!(await casUpdateCheckLock(db, env, lockValue, lockState))) {
          console.warn("[upstream-proxy] 健康检查锁已被其他实例接管，停止本轮写入");
          break;
        }
        lockValue = serializeLock(lockState);
      }

      return results;
    } finally {
      // 异常/提前返回（无配置、无候选、锁被接管）也复位，不残留 running=true
      if (healthCheckProgress) healthCheckProgress.running = false;
      runningCheck = null;
      // 释放锁：写 running=false 保留 total/checked（前端以 running=false
      // 判完成；CAS 失败 = 锁已易主，忽略）
      await casUpdateCheckLock(
        db,
        env,
        lockValue,
        { ...lockState, running: false, expiresAt: Math.floor(Date.now() / 1000) + CHECK_LOCK_TTL_SEC }
      ).catch(() => {});
    }
  })();
  return runningCheck;
}

/** 读取最近一次健康度结果与当前检查进度（管理页展示，非 Docker 部署或整体禁用返回空）。
 *  进度从 configs 表锁行读取（跨实例一致）：多实例 + LB 下轮询 GET 可能打到
 *  任意实例，进程内进度互不可见会返回残留旧进度（running=false + 旧 total）
 *  导致前端误判「检查完成」；落库后任意实例读到同一份进度 */
export async function getProxyHealth(
  db: D1Database | Database,
  env?: WorkerEnv
): Promise<{ results: ProxyHealthMap; progress: HealthCheckProgress }> {
  if (process.env.DEPLOY_PLATFORM !== "docker" || isUpstreamProxyDisabled()) {
    return { results: {}, progress: { running: false, total: 0, checked: 0, startedAt: 0 } };
  }
  const lock = await readCheckLock(db, env);
  const progress: HealthCheckProgress = lock
    ? {
        running: lock.running,
        total: lock.total,
        checked: lock.checked,
        startedAt: lock.startedAt * 1000,
      }
    : { running: false, total: 0, checked: 0, startedAt: 0 };
  return { results: await readProxyHealth(db, env), progress };
}