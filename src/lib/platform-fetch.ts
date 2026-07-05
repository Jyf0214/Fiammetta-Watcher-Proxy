/**
 * 平台级代理感知请求封装
 *
 * 自动检测平台是否配置了代理，若有则通过代理转发请求。
 * 代理失败时自动标记并回退到直连。
 */

import { selectProxy } from "./proxy-router";
import { proxyFetch, markProxyFailed, markProxySuccess } from "./proxy-fetch";
import type { PlatformConfig } from "@/types";

export interface PlatformFetchOptions extends RequestInit {
  /** 超时时间（毫秒），默认 120 秒 */
  timeout?: number;
}

/**
 * 通过平台的代理（或直连）发送请求
 *
 * 1. 检查平台是否有可用代理
 * 2. 若有，选择一个代理通过它转发
 * 3. 若代理请求失败，标记代理失败并回退直连
 * 4. 若无代理，直接发送
 */
export async function platformFetch(
  url: string,
  platform: PlatformConfig,
  options: PlatformFetchOptions = {}
): Promise<Response> {
  const { timeout = 120_000, ...fetchOptions } = options;

  // 尝试通过代理
  const proxy = await selectProxy(platform.id);
  if (proxy) {
    try {
      const res = await proxyFetch(url, proxy, { ...fetchOptions, timeout });
      // 2xx/3xx/4xx 都算代理连接成功（代理本身能通）
      if (res.status < 500) {
        await markProxySuccess(proxy.id);
        return res;
      }
      // 5xx 可能是上游问题，但代理本身是通的
      await markProxySuccess(proxy.id);
      return res;
    } catch (err) {
      // 代理连接失败（超时、连接拒绝等）
      console.warn(
        `[proxy] 代理 ${proxy.id} 请求失败，回退直连:`,
        err instanceof Error ? err.message : String(err)
      );
      await markProxyFailed(proxy.id);
      // 回退到直连（继续执行下面的逻辑）
    }
  }

  // 直连
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}
