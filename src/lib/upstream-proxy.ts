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
 *     "healthCheckUrl": "https://..."    // 可选，默认公网探测地址
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

/** 代理组：一源一组（sourceUrl 可空 = 纯手动组，不参与拉取） */
export interface ProxyGroupConfig {
  name: string;
  /** 拉取源地址（空 = 不拉取） */
  sourceUrl: string;
  /** 手动代理地址（与拉取结果合并为组内候选） */
  urls: string[];
}

export interface ProxyConfig {
  groups: ProxyGroupConfig[];
  /** 空数组 = 所有平台经代理（勾选=白名单） */
  platformIds: string[];
  /** 平台 → 组名映射（绑定后该平台固定使用指定组） */
  platformGroup: Record<string, string>;
  healthCheckUrl: string;
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
let cachedPoolUpdatedAt: number | null = null;
let lastPoolRefresh = 0;
let cachedHealth: ProxyHealthMap | null = null;
let cachedHealthUpdatedAt: number | null = null;
let lastHealthRefresh = 0;
/** url → ProxyAgent 池：配置集合变化时释放不再使用的代理 */
const proxyAgents = new Map<string, Dispatcher>();
/** round-robin 轮询游标 */
let roundRobinIndex = 0;
/** 进程内连续失败计数（url → 次数） */
const proxyFailCounts = new Map<string, number>();
/** 进程内临时不可用集合（网络层连续失败达阈值，健康检查成功时清除） */
const unhealthyUrls = new Set<string>();
/** 全部代理异常告警节流时间戳 */
let lastAllUnhealthyWarn = 0;

/** http(s) URL 且含主机名校验（new URL 解析 + hostname 非空） */
function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return /^https?:$/.test(parsed.protocol) && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

/** 日志用代理地址脱敏：剥离 URL 中的 user:pass 凭据，防止凭据进入服务端日志 */
function maskProxyUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    // 非法地址（可能含畸形凭据片段）：按 `//user:pass@` 特征打码；
    // [^@\s] 允许密码含 @，避免打码后泄漏剩余凭据片段
    return url.replace(/\/\/[^@\s]+@/, "//***@");
  }
}

/** 单行代理地址规范化：兼容裸 host:port（自动补 http://）与 http(s):// 前缀；非法行返回 null */
function normalizeProxyLine(lineRaw: string): string | null {
  const line = lineRaw.trim();
  if (!line) return null;
  // 带协议头的行必须是 http/https：socks5:// 等不支持协议直接拒绝，
  // 而不是误补成 http://socks5://... 这类畸形地址
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(line);
  if (hasScheme && !/^https?:\/\//i.test(line)) return null;
  const url = hasScheme ? line : `http://${line}`;
  return isValidHttpUrl(url) ? url : null;
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
        `[upstream-proxy] 不支持的代理地址（仅支持 http/https 且需含主机名），已忽略: ${maskProxyUrl(item).slice(0, 60)}`
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
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const sourceUrl = typeof g.sourceUrl === "string" ? g.sourceUrl.trim() : "";
      groups.push({
        name,
        // 拉取地址同样要求 http(s) + 主机名，防止畸形源 URL 让拉取任务反复失败
        sourceUrl: isValidHttpUrl(sourceUrl) ? sourceUrl : "",
        urls: normalizeUrls(g.urls),
      });
    }
  }

  if (groups.length === 0) {
    // 无显式组：旧版配置（顶层 urls）视为单组，行为与旧版一致
    if (legacyUrls.length === 0) return [];
    groups.push({ name: "", sourceUrl: "", urls: legacyUrls });
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

  return { groups, platformIds, platformGroup, healthCheckUrl };
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
      // 用 normalizeProxyLine 校验合法性：带非 http(s) 协议头的行与无 host 的行一律丢弃
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

/** 读取拉取结果（缓存模式与配置一致） */
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
        select: { updatedAt: true },
      });
      // 行缺失时 meta?.updatedAt 为 undefined，归一到 null 再比较（同 readProxyConfig）
      if ((meta?.updatedAt ?? null) === cachedPoolUpdatedAt) return cachedPool ?? {};
    } catch (err) {
      console.error("[upstream-proxy] 拉取结果失效检查失败，使用缓存:", err);
      return cachedPool ?? {};
    }
  }

  try {
    const row = await prisma.configs.findFirst({
      where: { key: UPSTREAM_PROXY_POOL_KEY },
      select: { value: true, updatedAt: true },
    });
    cachedPool = parsePoolMap(row?.value ?? null);
    cachedPoolUpdatedAt = row?.updatedAt ?? null;
  } catch (err) {
    console.error("[upstream-proxy] 读取拉取结果失败:", err);
    cachedPool = null;
    cachedPoolUpdatedAt = null;
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
  await prisma.configs.upsert({
    where: { key: UPSTREAM_PROXY_POOL_KEY },
    create: {
      id: crypto.randomUUID(),
      key: UPSTREAM_PROXY_POOL_KEY,
      value: JSON.stringify(pool),
      updatedAt: now,
    },
    update: { value: JSON.stringify(pool), updatedAt: now },
  });
  cachedPool = pool;
  cachedPoolUpdatedAt = now;
}

/** 读取健康度记录（缓存模式与配置一致） */
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
        select: { updatedAt: true },
      });
      // 行缺失时 meta?.updatedAt 为 undefined，归一到 null 再比较（同 readProxyConfig）
      if ((meta?.updatedAt ?? null) === cachedHealthUpdatedAt) return cachedHealth ?? {};
    } catch (err) {
      console.error("[upstream-proxy] 健康度失效检查失败，使用缓存:", err);
      return cachedHealth ?? {};
    }
  }

  try {
    const row = await prisma.configs.findFirst({
      where: { key: UPSTREAM_PROXY_HEALTH_KEY },
      select: { value: true, updatedAt: true },
    });
    cachedHealth = parseHealthMap(row?.value ?? null);
    cachedHealthUpdatedAt = row?.updatedAt ?? null;
  } catch (err) {
    console.error("[upstream-proxy] 读取健康度失败:", err);
    cachedHealth = null;
    cachedHealthUpdatedAt = null;
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
  await prisma.configs.upsert({
    where: { key: UPSTREAM_PROXY_HEALTH_KEY },
    create: {
      id: crypto.randomUUID(),
      key: UPSTREAM_PROXY_HEALTH_KEY,
      value: JSON.stringify(map),
      updatedAt: now,
    },
    update: { value: JSON.stringify(map), updatedAt: now },
  });
  cachedHealth = map;
  cachedHealthUpdatedAt = now;
}

// ===== ProxyAgent 池 =====

/** 获取/创建 url 对应的 ProxyAgent（池化复用） */
async function getAgent(url: string): Promise<Dispatcher> {
  let agent = proxyAgents.get(url);
  if (!agent) {
    const { ProxyAgent } = await import("undici");
    agent = new ProxyAgent(url);
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
      void agent.close().catch(() => {});
    }
  }
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
    // 必须消费响应体：未读取的 body 会使 undici 连接保持占用（keep-alive 不复用），
    // 健康检查每轮对每个代理泄漏一个连接，fd/内存耗尽导致进程崩溃（无日志）
    try {
      await res.arrayBuffer();
    } catch {
      // 读 body 失败（含 mock/异常响应）不改变探测判定；能取消则取消，避免连接滞留
      await res.body?.cancel().catch(() => {});
    }
    return { ok: res.ok, latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timeoutId);
  }
}

/** 收集全部组的代理候选（拉取结果 ∪ 手动代理，去重） */
function collectAllGroupUrls(config: ProxyConfig, pool: Record<string, string[]>): string[] {
  const urls = new Set<string>();
  for (const group of config.groups) {
    for (const u of group.urls) urls.add(u);
    for (const u of pool[group.name] ?? []) urls.add(u);
  }
  return [...urls];
}

/** 目标组选择：平台绑定优先，未绑定走默认组（第一组） */
function resolveTargetGroup(config: ProxyConfig, platformId: string | undefined): ProxyGroupConfig {
  if (platformId && config.platformGroup[platformId]) {
    const bound = config.groups.find((g) => g.name === config.platformGroup[platformId]);
    if (bound) return bound;
  }
  return config.groups[0];
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
  // 与 getUpstreamProxy 相同的部署门控：非 Docker 部署不创建代理/写库
  if (process.env.DEPLOY_PLATFORM !== "docker") return {};

  const config = await readProxyConfig(db, env);
  if (!config) return {};
  const pullGroups = config.groups.filter((g) => g.sourceUrl.length > 0);
  if (pullGroups.length === 0) return {};

  const prevPool = await readProxyPool(db, env);
  const prevHealth = await readProxyHealth(db, env);
  const nextPool: Record<string, string[]> = { ...prevPool };
  const nextHealth: ProxyHealthMap = { ...prevHealth };
  const results: Record<string, ProxyPullGroupResult> = {};

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

    // 交集：保留健康度记录，状态切换为 ok（最新拉取列表确认其存在 = 恢复在池），
    // 清除进程内黑名单与计数，真实连通性由后续健康检查重新判定
    for (const u of kept) {
      const entry = nextHealth[u];
      if (entry) entry.status = "ok"; // failCount/延迟等历史保留，展示用
      unhealthyUrls.delete(u);
      proxyFailCounts.set(u, 0);
    }
    // 移除：健康记录随代理一起删除，进程内状态同步清理
    for (const u of removed) {
      delete nextHealth[u];
      unhealthyUrls.delete(u);
      proxyFailCounts.delete(u);
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
  try {
    await writeProxyHealth(db, env, nextHealth);
  } catch (err) {
    console.error("[upstream-proxy] 拉取后健康状态写入失败:", err);
  }

  // 释放被移除代理的连接（fire-and-forget close，安全）
  await releaseStaleAgents(new Set(collectAllGroupUrls(config, nextPool)));
  return results;
}

// ===== 请求路由 =====

/**
 * 选择出站代理（无代理配置/非 Docker 部署/平台不在白名单时返回 null）
 *
 * 组选择：平台绑定组优先；未绑定的白名单平台走默认组（第一组）。
 * 组内多代理按 round-robin 轮询；健康度异常（表记录 fail 或进程内连续
 * 失败达阈值）的代理跳过；全部异常时回退组内全部代理轮询并告警。
 * 调用方应把返回值注入上游 fetch 的 init.dispatcher（undici 扩展字段），
 * 并在网络层失败时用返回的 url 调用 markProxyFailure 回标记。
 */
export async function getUpstreamProxy(
  db: D1Database | Database,
  env?: WorkerEnv,
  platformId?: string
): Promise<UpstreamProxySelection> {
  // 仅 Docker 部署：边缘运行时（workerd）没有 undici 连接池，且代理
  // 服务器通常是容器网络内的地址，其他部署形态不适用
  if (process.env.DEPLOY_PLATFORM !== "docker") return { dispatcher: null, url: null };

  const config = await readProxyConfig(db, env);
  if (!config) {
    await releaseStaleAgents(new Set());
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
  const pool = await readProxyPool(db, env);
  const allUrls = collectAllGroupUrls(config, pool);
  const groupUrls = [...new Set([...group.urls, ...(pool[group.name] ?? [])])];
  if (groupUrls.length === 0) {
    // 组内无代理（如拉取尚未成功）：返回直连，同时保持代理池与其他组同步
    await releaseStaleAgents(new Set(allUrls));
    return { dispatcher: null, url: null };
  }

  // 保持代理池与全部组配置集合同步（跨组复用连接）
  await releaseStaleAgents(new Set(allUrls));

  const health = await readProxyHealth(db, env);
  let candidates = groupUrls.filter(
    (url) => health[url]?.status !== "fail" && !unhealthyUrls.has(url)
  );
  if (candidates.length === 0) {
    // 全部代理健康度异常：回退全部代理轮询（健康检查是周期性的，
    // 期间的临时故障不应使配置了代理的请求直接改走直连）。
    // 告警节流到每分钟一次，避免代理持续故障期间每个请求刷日志
    const now = Date.now();
    if (now - lastAllUnhealthyWarn > 60_000) {
      console.warn("[upstream-proxy] 所有代理健康度异常，回退全部代理轮询");
      lastAllUnhealthyWarn = now;
    }
    candidates = groupUrls;
  }

  const url = candidates[roundRobinIndex % candidates.length];
  roundRobinIndex++;
  return { dispatcher: await getAgent(url), url };
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
    const health = await readProxyHealth(db, env);
    health[url] = {
      status: "fail",
      latencyMs: 0,
      checkedAt: Math.floor(Date.now() / 1000),
      failCount: count,
    };
    await writeProxyHealth(db, env, health);
  } catch (err) {
    console.error("[upstream-proxy] 标记代理失败状态写入失败:", err);
  }
}

/**
 * 健康检查：对每个配置的代理发起探测请求，结果写入健康度表
 * （cron proxy-health 任务与管理页「立即检查」共用）
 */
export async function runProxyHealthCheck(
  db: D1Database | Database,
  env?: WorkerEnv
): Promise<ProxyHealthMap> {
  // 与 getUpstreamProxy/getProxyHealth 相同的部署门控：cron 在非 Docker
  // 部署下可能残留代理配置，不应创建 ProxyAgent 或写入健康表
  if (process.env.DEPLOY_PLATFORM !== "docker") return {};

  const config = await readProxyConfig(db, env);
  if (!config) return {};

  const pool = await readProxyPool(db, env);
  const allUrls = collectAllGroupUrls(config, pool);
  if (allUrls.length === 0) return {};

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
  }

  try {
    // 合并写入：健康检查与 markProxyFailure 可能并发读写健康表（各自读改写
    // 整表），保留 prev 中仍属于当前候选、但本次未生成结果的条目，避免
    // 全表丢弃性覆盖（进程内集合才是轮询判定的权威，表数据为展示与重启恢复）
    const merged: ProxyHealthMap = {};
    for (const url of allUrls) merged[url] = results[url] ?? prev[url];
    await writeProxyHealth(db, env, merged);
  } catch (err) {
    console.error("[upstream-proxy] 健康度结果写入失败:", err);
  }
  return results;
}

/** 读取最近一次健康度结果（管理页展示，非 Docker 部署返回空） */
export async function getProxyHealth(
  db: D1Database | Database,
  env?: WorkerEnv
): Promise<ProxyHealthMap> {
  if (process.env.DEPLOY_PLATFORM !== "docker") return {};
  return readProxyHealth(db, env);
}