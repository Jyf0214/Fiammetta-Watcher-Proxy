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
 * 脱敏代理地址（隐藏密码部分）
 * http://user:pass@host:port → http://user:***@host:port
 */
function maskProxyAddress(address: string): string {
  return address.replace(/(:\/\/[^:]+:)([^@]+)(@)/, "$1***$3");
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
    if (isDebug) console.log(`[proxy-debug] 代理地址解析失败: ${maskProxyAddress(proxyAddress)}`);
    return null;
  }

  if (isDebug) console.log(`[proxy-debug] 创建 agent: protocol=${parsed.protocol} address=${maskProxyAddress(parsed.url)}`);

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
 * 根据封禁次数计算封禁时长
 *
 * 第 1 次封禁：15 分钟
 * 第 2 次封禁：5 小时
 * 第 3 次及以后：24 小时
 */
function getBanDurationMs(banCount: number): number {
  if (banCount <= 1) return 15 * 60 * 1000; // 15 分钟
  if (banCount === 2) return 5 * 60 * 60 * 1000; // 5 小时
  return 24 * 60 * 60 * 1000; // 24 小时
}

/**
 * 标记代理失败（一次失败即封禁，事务内原子读写）
 */
export async function markProxyFailed(proxyId: string): Promise<void> {
  const { prisma } = await import("./prisma");
  const now = new Date();

  // 事务内读取当前 banCount 再递增，确保并发请求不会覆盖
  const result = await prisma.$transaction(async (tx) => {
    const proxy = await tx.proxy.findUnique({
      where: { id: proxyId },
      select: { banCount: true },
    });
    if (!proxy) return null;

    const newBanCount = proxy.banCount + 1;
    const banDuration = getBanDurationMs(newBanCount);
    const cooldownEnd = new Date(now.getTime() + banDuration);

    await tx.proxy.update({
      where: { id: proxyId },
      data: {
        status: "down",
        failCount: 0,
        banCount: newBanCount,
        lastFailAt: now,
        cooldownEnd,
      },
    });

    return { newBanCount, banDuration, cooldownEnd };
  });

  if (!result) return;

  const durationLabel =
    result.banDuration <= 15 * 60 * 1000
      ? "15 分钟"
      : result.banDuration <= 5 * 60 * 60 * 1000
        ? "5 小时"
        : "24 小时";
  console.warn(
    `[proxy] 代理 ${proxyId} 请求失败，封禁 ${durationLabel}（第 ${result.newBanCount} 次封禁，至 ${result.cooldownEnd.toISOString()}）`
  );
}

/**
 * 标记代理成功（重置失败计数）
 */
export async function markProxySuccess(proxyId: string): Promise<void> {
  const { prisma } = await import("./prisma");

  // 读取当前状态，仅在状态需要变更时记录日志
  const proxy = await prisma.proxy.findUnique({
    where: { id: proxyId },
    select: { failCount: true, status: true },
  });

  if (proxy && (proxy.failCount > 0 || proxy.status !== "healthy")) {
    console.log(
      `[proxy] 代理 ${proxyId} 状态恢复: ${proxy.status} → healthy, failCount: ${proxy.failCount} → 0`
    );
  }

  await prisma.proxy.update({
    where: { id: proxyId },
    data: { failCount: 0, status: "healthy", cooldownEnd: null },
  });
}
