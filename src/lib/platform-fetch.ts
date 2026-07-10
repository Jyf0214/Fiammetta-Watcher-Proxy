/**
 * 平台级代理感知请求封装
 *
 * 自动检测全局代理池中是否有可用代理，若有则通过代理转发请求。
 * 代理失败时自动标记并回退到直连。
 */

import { selectProxy, releaseProxy } from "./proxy-router";
import { proxyFetch, markProxyFailed, markProxySuccess } from "./proxy-fetch";
import { isDebug } from "./auth-helpers";
import type { PlatformConfig } from "@/types";

export interface PlatformFetchOptions extends RequestInit {
  /** 超时时间（毫秒），默认 120 秒 */
  timeout?: number;
  /** 当前请求的 API Key ID，用于代理并发占用追踪 */
  keyId?: string;
}

/**
 * 通过全局代理池（或直连）发送请求
 *
 * 1. 从全局代理池选择一个可用代理
 * 2. 若有，通过它转发请求
 * 3. 若代理请求失败，标记代理失败并回退直连
 * 4. 若无代理，直接发送
 */
export async function platformFetch(
  url: string,
  platform: PlatformConfig,
  options: PlatformFetchOptions = {}
): Promise<Response> {
  const { timeout = 120_000, keyId, ...fetchOptions } = options;

  // 从全局代理池选择代理
  const proxy = await selectProxy(platform.id, keyId);
  let proxyReleased = false;

  if (isDebug) {
    console.log(
      `[proxy-debug] platformFetch url=${url} platform=${platform.name}(${platform.id}) proxy=${proxy ? `${proxy.address} id=${proxy.id}` : "null(无可用代理)"} keyId=${keyId || "none"}`
    );
  }

  if (proxy) {
    try {
      if (isDebug) {
        console.log(`[proxy-debug] 通过代理 ${proxy.id}(${proxy.address}) 发送请求 → ${url}`);
      }

      const res = await proxyFetch(url, proxy, { ...fetchOptions, timeout });

      if (isDebug) {
        console.log(`[proxy-debug] 代理 ${proxy.id} 响应: status=${res.status} statusText=${res.statusText}`);
      }

      // 2xx/3xx/4xx 都算代理连接成功（代理本身能通）
      if (res.status < 500) {
        await markProxySuccess(proxy.id);
        releaseProxy(platform.id, proxy.id, keyId || "");
        proxyReleased = true;
        return res;
      }
      // 5xx 可能是上游问题，但代理本身是通的
      await markProxySuccess(proxy.id);
      releaseProxy(platform.id, proxy.id, keyId || "");
      proxyReleased = true;
      return res;
    } catch (err) {
      const errMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.warn(
        `[proxy] 代理 ${proxy.id} 请求失败，回退直连: ${errMsg}`
      );
      if (isDebug) {
        console.warn(`[proxy-debug] 代理 ${proxy.id} 失败详情:`, err);
      }
      await markProxyFailed(proxy.id);
      // 回退到直连（继续执行下面的逻辑）
    }
  }

  // 直连
  if (isDebug) {
    console.log(`[proxy-debug] 直连发送请求 → ${url}`);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });

    if (isDebug) {
      console.log(`[proxy-debug] 直连响应: status=${res.status} statusText=${res.statusText}`);
    }

    return res;
  } finally {
    clearTimeout(timeoutId);
    if (proxy && !proxyReleased) {
      releaseProxy(platform.id, proxy.id, keyId || "");
    }
  }
}
