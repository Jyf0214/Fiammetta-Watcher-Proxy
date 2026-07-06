/**
 * 代理感知的 fetch 封装
 *
 * 根据代理地址自动选择 HTTP/HTTPS 或 SOCKS5 代理 agent，
 * 通过代理转发请求到上游平台。
 */

import type { Proxy } from "@prisma/client";
import { isDebug } from "./auth-helpers";

/** 解析后的代理信息 */
interface ParsedProxy {
  protocol: string;
  url: string;
}

/**
 * 解析代理地址
 */
function parseProxy(address: string): ParsedProxy | null {
  try {
    const url = new URL(address);
    const protocol = url.protocol.replace(":", "");
    if (!["http", "https", "socks5"].includes(protocol)) return null;
    return { protocol, url: address };
  } catch {
    return null;
  }
}

/**
 * 为请求创建代理 agent
 *
 * HTTP/HTTPS 代理 → HttpsProxyAgent
 * SOCKS5 代理 → SocksProxyAgent
 */
async function createAgent(proxyAddress: string) {
  const parsed = parseProxy(proxyAddress);
  if (!parsed) {
    if (isDebug) console.log(`[proxy-debug] 代理地址解析失败: ${proxyAddress}`);
    return null;
  }

  if (isDebug) console.log(`[proxy-debug] 创建 agent: protocol=${parsed.protocol} address=${parsed.url}`);

  if (parsed.protocol === "socks5") {
    const { SocksProxyAgent } = await import("socks-proxy-agent");
    return new SocksProxyAgent(parsed.url);
  } else {
    const { HttpsProxyAgent } = await import("https-proxy-agent");
    return new HttpsProxyAgent(parsed.url);
  }
}

export interface ProxyFetchOptions extends RequestInit {
  /** 超时时间（毫秒），默认 120 秒 */
  timeout?: number;
}

/**
 * 通过代理发送请求
 *
 * @param url 目标 URL
 * @param proxy 代理记录（来自数据库）
 * @param options fetch 选项
 * @returns Response 对象
 */
export async function proxyFetch(
  url: string,
  proxy: Proxy,
  options: ProxyFetchOptions = {}
): Promise<Response> {
  const { timeout = 120_000, ...fetchOptions } = options;

  const agent = await createAgent(proxy.address);
  if (!agent) {
    throw new Error(`无效的代理地址: ${proxy.address}`);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  if (isDebug) {
    console.log(`[proxy-debug] proxyFetch 发送请求: proxy=${proxy.id} → ${url} timeout=${timeout}ms`);
  }

  try {
    const res = await fetch(url, {
      ...fetchOptions,
      // @ts-expect-error agent is for Node.js fetch dispatcher
      agent,
      signal: controller.signal,
    });

    if (isDebug) {
      console.log(`[proxy-debug] proxyFetch 收到响应: proxy=${proxy.id} status=${res.status} url=${url}`);
    }

    return res;
  } finally {
    clearTimeout(timeoutId);
    agent.destroy?.();
  }
}

/**
 * 标记代理失败（更新数据库状态）
 */
export async function markProxyFailed(proxyId: string): Promise<void> {
  const { prisma } = await import("./prisma");
  const now = new Date();

  const proxy = await prisma.proxy.findUnique({ where: { id: proxyId } });
  if (!proxy) return;

  const newFailCount = proxy.failCount + 1;
  const FAILURE_THRESHOLD = 3;
  const BAN_DURATION_MS = 30 * 60 * 1000;

  const newStatus = newFailCount >= FAILURE_THRESHOLD ? "down" : "degraded";
  const cooldownEnd =
    newFailCount >= FAILURE_THRESHOLD
      ? new Date(now.getTime() + BAN_DURATION_MS)
      : null;

  await prisma.proxy.update({
    where: { id: proxyId },
    data: {
      failCount: newFailCount,
      status: newStatus,
      lastFailAt: now,
      ...(cooldownEnd ? { cooldownEnd } : {}),
    },
  });

  if (newFailCount >= FAILURE_THRESHOLD) {
    console.warn(
      `[proxy] 代理 ${proxyId} 连续失败 ${newFailCount} 次，封禁至 ${cooldownEnd?.toISOString()}`
    );
  }
}

/**
 * 标记代理成功（重置失败计数）
 */
export async function markProxySuccess(proxyId: string): Promise<void> {
  const { prisma } = await import("./prisma");

  await prisma.proxy.update({
    where: { id: proxyId },
    data: { failCount: 0, status: "healthy", cooldownEnd: null },
  });
}
