/**
 * 平台级代理感知请求封装
 *
 * 自动检测全局代理池中是否有可用代理，若有则通过代理转发请求。
 * 代理失败时自动选择下一个可用代理重试，全部失败后回退到直连。
 */

import { selectProxy, releaseProxy } from "./proxy-router";
import { proxyFetch, markProxyFailed, markProxySuccess } from "./proxy-fetch";
import { isDebug } from "./auth-helpers";
import { isResolvedAddressSafe } from "./url-validation";
import type { PlatformConfig } from "@/types";

export interface PlatformFetchOptions extends RequestInit {
  /** 超时时间（毫秒），默认 120 秒 */
  timeout?: number;
  /** 当前请求的 API Key ID，用于代理并发占用追踪 */
  keyId?: string;
  /** 代理失败后最大重试次数（尝试不同代理），默认 2 */
  maxRetries?: number;
}

/**
 * 通过全局代理池（或直连）发送请求
 *
 * 1. 从全局代理池选择一个可用代理
 * 2. 若有，通过它转发请求
 * 3. 若代理失败，标记失败并选择下一个可用代理重试
 * 4. 所有代理均失败后，回退到直连
 * 5. 若无代理，直接发送
 */
export async function platformFetch(
  url: string,
  platform: PlatformConfig,
  options: PlatformFetchOptions = {}
): Promise<Response> {
  const { timeout = 120_000, keyId, maxRetries = 2, ...fetchOptions } = options;

  // 请求时 DNS 解析校验（防御 DNS 重绑定 SSRF）
  try {
    const targetUrl = new URL(url);
    const safe = await isResolvedAddressSafe(targetUrl.hostname);
    if (!safe) {
      console.warn(
        `[security] 请求时 DNS 解析校验失败: ${url} → 目标 IP 属于内网/保留地址，拒绝请求`
      );
      return new Response(
        JSON.stringify({ error: "目标地址解析为内网地址，出于安全考虑不被允许" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }
  } catch {
    // URL 解析失败，让后续请求自然失败
  }

  // 尝试多个代理
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const proxy = await selectProxy(platform.id, keyId);

    if (!proxy) break; // 无可用代理，跳出循环走直连

    if (isDebug) {
      console.log(
        `[proxy-debug] platformFetch attempt=${attempt + 1}/${maxRetries + 1} url=${url} platform=${platform.name}(${platform.id}) proxy=${proxy.address.replace(/(:\/\/[^:]+:)([^@]+)(@)/, "$1***$3")} id=${proxy.id} keyId=${keyId || "none"}`
      );
    }

    try {
      const res = await proxyFetch(url, proxy, { ...fetchOptions, timeout });

      if (isDebug) {
        console.log(`[proxy-debug] 代理 ${proxy.id} 响应: status=${res.status}`);
      }

      // 任何 HTTP 响应都算代理连接成功
      await markProxySuccess(proxy.id);
      releaseProxy(platform.id, proxy.id, keyId || "");
      return res;
    } catch (err) {
      const errMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.warn(
        `[proxy] 代理 ${proxy.id} 请求失败 (attempt ${attempt + 1}/${maxRetries + 1})，${attempt < maxRetries ? "尝试下一个代理" : "回退直连"}: ${errMsg}`
      );
      await markProxyFailed(proxy.id);
      releaseProxy(platform.id, proxy.id, keyId || "");
      // 继续循环，selectProxy 会选下一个可用代理
    }
  }

  // 直连（所有代理均失败或无代理时）
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
      console.log(`[proxy-debug] 直连响应: status=${res.status}`);
    }

    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}
