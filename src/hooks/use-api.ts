"use client";

import { useEffect, useRef } from "react";
import useSWR, { type SWRConfiguration } from "swr";
import { message } from "antd";
import i18n from "@/lib/i18n";

/**
 * 管理后台统一数据层（SWR）
 *
 * 背景：改造前各页面用 useEffect + fetch + AbortController 各自拉取，
 * 同一端点（/api/admin/keys、/api/admin/platforms）多页重复请求、
 * Tab 切换与页面回退全部重拉。统一后：
 *
 * - apiFetcher 收敛 401 处理与 success 检查，返回业务数据 data；
 * - useApi 以 URL 为 key 共享缓存与请求（相同 key 自动去重），
 *   key 含查询参数时参数变化自动重新请求；
 * - AbortController 语义由 SWR 内置（key 变化/组件卸载时自动忽略过期结果）。
 */

/** API 统一响应结构（与 pages/api/admin/* 约定一致） */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string | { message?: string } | null;
}

/** 401 错误标记：fetcher 已提示并跳转登录页，页面级错误提示应跳过该错误 */
export const UNAUTHORIZED_MESSAGE = "unauthorized";

/** 从响应体中提取可读错误信息 */
function extractErrorMessage(body: ApiResponse | null, status: number): string {
  const raw = body?.error;
  if (typeof raw === "string") {
    if (raw) return raw;
  } else if (raw?.message) {
    return raw.message;
  }
  return `请求失败（HTTP ${status}）`;
}

/**
 * 统一 fetcher：fetch → JSON → 401 统一处理 → success 检查 → 返回 data
 *
 * - 401：提示未授权并跳转 /admin/login（原各页面分散的 401 处理收敛于此）
 * - success !== true：抛出 Error（message 为服务端 error 信息，供页面展示）
 * - 成功：返回 body.data，页面直接消费业务数据，无需再解包
 */
export async function apiFetcher<T = unknown>(url: string): Promise<T> {
  const res = await fetch(url);
  let body: ApiResponse<T> | null;
  try {
    body = (await res.json()) as ApiResponse<T>;
  } catch {
    body = null; // 非 JSON 响应（如代理错误页）
  }

  if (res.status === 401) {
    // 登录态失效：统一提示 + 硬跳转登录页（清空内存登录态，避免停留失效会话）；
    // 携带当前深链，登录成功后回跳原页面（login 页消费 ?redirect=）
    message.warning(i18n.t("auth:unauthorized"));
    if (typeof window !== "undefined") {
      const returnTo = `${window.location.pathname}${window.location.search}`;
      window.location.replace(`/admin/login?redirect=${encodeURIComponent(returnTo)}`);
    }
    throw new Error(UNAUTHORIZED_MESSAGE);
  }

  if (!body || body.success !== true) {
    throw new Error(extractErrorMessage(body, res.status));
  }
  return body.data as T;
}

/**
 * 管理后台统一数据层 hook
 *
 * - key 即 URL（或含查询参数的完整 URL）；key 变化时 SWR 自动重新请求
 * - 相同 key 的多处调用共享同一请求与缓存（跨组件去重）
 * - 返回 SWR 完整状态：data / error / isLoading / isValidating / mutate
 */
export function useApi<T>(key: string | null, options?: SWRConfiguration<T>) {
  return useSWR<T, Error>(key, apiFetcher, options);
}

/**
 * 兼容现有 refreshKey 计数机制的重新验证触发器：
 * refreshKey 变化时调用 mutate 重新拉取当前 key 数据。
 * 用于以最小改动接入 SWR 的页面（父组件仍传 refreshKey prop）。
 */
export function useRefreshKey(refreshKey: number, mutate: () => void) {
  const prevRef = useRef(refreshKey);
  useEffect(() => {
    if (prevRef.current !== refreshKey) {
      prevRef.current = refreshKey;
      mutate();
    }
  }, [refreshKey, mutate]);
}
