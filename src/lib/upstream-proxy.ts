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
 *     "urls": ["http://127.0.0.1:7890", "http://127.0.0.1:7891"],  // 多代理 round-robin
 *     "platformIds": ["p1", "p2"],   // 空数组 = 所有平台经代理（勾选=白名单）
 *     "healthCheckUrl": "https://..."  // 可选，默认公网探测地址
 *   }
 * 兼容旧版纯 URL 字符串格式（视为单代理 + 全部平台）。
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
/** 健康度记录键 */
export const UPSTREAM_PROXY_HEALTH_KEY = "system:upstream_proxy_health";
/** 默认健康检查探测地址（HTTP 204，轻量；可选国内可达的 Cloudflare 联通性端点） */
export const DEFAULT_PROXY_HEALTH_CHECK_URL = "https://cp.cloudflare.com/generate_204";

/** 缓存有效期：与 request-templates 的模板缓存一致（30s + updatedAt 失效检查） */
const CACHE_TTL = 30_000;
/** 健康检查单次超时（毫秒） */
const HEALTH_CHECK_TIMEOUT_MS = 10_000;
/** 业务请求网络层连续失败达到该次数 → 该代理临时标记不可用（跳过轮询） */
export const PROXY_FAIL_THRESHOLD = 3;

export interface ProxyConfig {
  urls: string[];
  platformIds: string[];
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

let cachedConfig: ProxyConfig | null = null;
let cachedConfigUpdatedAt: number | null = null;
let lastConfigRefresh = 0;
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

/** 解析并规范化配置（兼容旧版纯 URL 字符串），无有效代理时返回 null */
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
  const rawUrls = Array.isArray(input.urls) ? input.urls : [];
  const urls: string[] = [];
  for (const item of rawUrls) {
    if (typeof item !== "string") continue;
    const u = item.trim();
    if (!u) continue;
    // 协议 + host 双重校验：http://（空 host）会让 ProxyAgent 在请求期抛错
    if (!/^https?:\/\//i.test(u) || !isValidHttpUrl(u)) {
      console.error(
        `[upstream-proxy] 不支持的代理地址（仅支持 http/https 且需含主机名），已忽略: ${u.slice(0, 40)}...`
      );
      continue;
    }
    if (!urls.includes(u)) urls.push(u);
  }
  if (urls.length === 0) return null;

  const platformIds = Array.isArray(input.platformIds)
    ? [...new Set(input.platformIds.filter((p): p is string => typeof p === "string" && p.length > 0))]
    : [];

  let healthCheckUrl = typeof input.healthCheckUrl === "string" ? input.healthCheckUrl.trim() : "";
  if (!isValidHttpUrl(healthCheckUrl)) healthCheckUrl = DEFAULT_PROXY_HEALTH_CHECK_URL;

  return { urls, platformIds, healthCheckUrl };
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

/**
 * 读取代理配置（带缓存：TTL 内先用 configs.updatedAt 做廉价失效检查，
 * 管理后台保存后立即生效）
 */
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
    return { ok: res.ok, latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 选择出站代理（无代理配置/非 Docker 部署/平台不在白名单时返回 null）
 *
 * 多代理按 round-robin 轮询；健康度异常（表记录 fail 或进程内连续失败
 * 达阈值）的代理跳过；全部异常时回退全部代理轮询并告警。
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
  // 未传 platformId 的调用方无法判断归属，按不在名单内处理（直连）
  if (config.platformIds.length > 0 && (!platformId || !config.platformIds.includes(platformId))) {
    return { dispatcher: null, url: null };
  }

  // 保持代理池与配置集合同步
  await releaseStaleAgents(new Set(config.urls));

  const health = await readProxyHealth(db, env);
  let candidates = config.urls.filter(
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
    candidates = config.urls;
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

  const prev = await readProxyHealth(db, env);
  const results: ProxyHealthMap = {};

  await Promise.allSettled(
    config.urls.map(async (url) => {
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

  try {
    // 合并写入：健康检查与 markProxyFailure 可能并发读写健康表（各自读改写
    // 整表），保留 prev 中仍属于当前配置、但本次未生成结果的条目，避免
    // 全表丢弃性覆盖（进程内集合才是轮询判定的权威，表数据为展示与重启恢复）
    const merged: ProxyHealthMap = {};
    for (const url of config.urls) merged[url] = results[url] ?? prev[url];
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