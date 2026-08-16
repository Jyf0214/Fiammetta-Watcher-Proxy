/**
 * 出站代理 — 网关访问上游 API（OpenAI/Anthropic 等）时经代理服务器出网
 *
 * 仅 Docker 部署（DEPLOY_PLATFORM=docker，Node 运行时）可用：
 * - Node 全局 fetch（undici）默认不读取 HTTP_PROXY 等环境变量，需显式
 *   注入 dispatcher 才能走代理；
 * - 边缘运行时（Cloudflare workerd）无 undici 连接池/TCP 能力，任何平台
 *   校验先于加载，且 undici 动态 import 保证边缘构建/运行不受影响。
 *
 * 配置：configs 表 key=system:upstream_proxy，value 为代理服务器 URL
 * （http:// 或 https://，示例 http://127.0.0.1:7890）。管理后台保存后
 * 通过 updatedAt 失效检查即时生效，未配置/为空时返回 null（直连）。
 */

import { createDb, type Database } from "@/lib/prisma";
import type { WorkerEnv } from "../../worker/src/config";

// type-only import：打包期擦除，边缘运行时（workerd）不加载 undici 实现
import type { Dispatcher } from "undici";

/** 配置键：configs 表中存储的代理服务器 URL */
export const UPSTREAM_PROXY_CONFIG_KEY = "system:upstream_proxy";

/** 缓存有效期：与 request-templates 的模板缓存一致（30s + updatedAt 失效检查） */
const CACHE_TTL = 30_000;

let cachedUrl: string | null = null;
let cachedUpdatedAt: number | null = null;
let lastRefresh = 0;
let proxyAgent: Dispatcher | null = null;

/**
 * 读取代理 URL 配置（带缓存）
 *
 * 缓存未过期时先用 configs.updatedAt 做廉价失效检查：管理后台每次保存
 * 都更新 updatedAt，发生变化即强制重载，保证保存后立即生效。
 */
async function readProxyUrl(
  db: D1Database | Database,
  env?: WorkerEnv
): Promise<string | null> {
  const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
  const now = Date.now();

  if (lastRefresh !== 0 && now - lastRefresh < CACHE_TTL) {
    try {
      const meta = await prisma.configs.findFirst({
        where: { key: UPSTREAM_PROXY_CONFIG_KEY },
        select: { updatedAt: true },
      });
      if (meta?.updatedAt === cachedUpdatedAt) return cachedUrl;
    } catch (err) {
      // 失效检查失败时退回 TTL 缓存，不阻断请求
      console.error("[upstream-proxy] 缓存失效检查失败，使用缓存:", err);
      return cachedUrl;
    }
  }

  try {
    const row = await prisma.configs.findFirst({
      where: { key: UPSTREAM_PROXY_CONFIG_KEY },
      select: { value: true, updatedAt: true },
    });
    cachedUrl = row?.value?.trim() || null;
    cachedUpdatedAt = row?.updatedAt ?? null;
  } catch (err) {
    console.error("[upstream-proxy] 读取代理配置失败:", err);
    cachedUrl = null;
    cachedUpdatedAt = null;
  }
  lastRefresh = now;
  return cachedUrl;
}

/**
 * 获取出站代理 dispatcher（无代理配置或非 Docker 部署返回 null）
 *
 * 调用方应把返回值注入上游 fetch 的 init.dispatcher（undici 扩展字段）。
 * 代理 URL 变化时自动重建 ProxyAgent；非 http(s) 协议（如 socks://）
 * 不被支持，视为未配置并告警。
 */
export async function getUpstreamProxyDispatcher(
  db: D1Database | Database,
  env?: WorkerEnv
): Promise<Dispatcher | null> {
  // 仅 Docker 部署：边缘运行时（workerd）没有 undici 连接池，且代理
  // 服务器通常是容器网络内的地址，其他部署形态不适用
  if (process.env.DEPLOY_PLATFORM !== "docker") return null;

  const url = await readProxyUrl(db, env);
  if (!url) {
    if (proxyAgent && cachedUrl === null) {
      // 配置被清空：释放旧代理，恢复直连
      await proxyAgent.close().catch(() => {});
      proxyAgent = null;
    }
    return null;
  }

  if (!/^https?:\/\//i.test(url)) {
    console.error(
      `[upstream-proxy] 不支持的代理协议（仅支持 http/https）: ${url.slice(0, 40)}...`
    );
    return null;
  }

  if (!proxyAgent || cachedUrl !== url) {
    if (proxyAgent) await proxyAgent.close().catch(() => {});
    const { ProxyAgent } = await import("undici");
    proxyAgent = new ProxyAgent(url);
  }
  return proxyAgent;
}