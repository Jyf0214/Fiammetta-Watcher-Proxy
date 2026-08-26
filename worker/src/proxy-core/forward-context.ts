/**
 * 上游请求上下文构造核心（proxy-core 第七块）
 *
 * worker/src/proxy.ts 全量版、worker/src/proxy-lite.ts lite 版、
 * pages/api/v1/[[...v1]].ts Pages 版此前各自内联实现了同一段「透传头过滤 →
 * 上游 URL 构造 → 上游请求头组装」管线，三份实现语义一致：
 * - 透传头：只保留合法 header 名（Workers fetch 对非法名抛 TypeError），
 *   并丢弃 FORBIDDEN_FORWARD_HEADERS 黑名单（认证/请求语义类头不得被下游
 *   白名单透传覆盖——否则任意客户端可替换平台密钥或破坏请求语义）；
 * - 上游 URL：Anthropic 协议上游指向 {base}/v1/messages，其余为 {base}{path}
 *   （baseUrl 去尾部斜杠）；
 * - 认证头：Anthropic 用 x-api-key + anthropic-version，其余用 Bearer；
 *   multipart 保留原始 Content-Type（boundary 必须原样）；平台 extraHeaders
 *   强制覆盖透传头；reuseUserAgent 时自定义 UA 优先级最高。
 * 本模块把这些语义固化为唯一实现，三端统一导入，消除副本漂移。
 */

import {
  FORBIDDEN_FORWARD_HEADERS,
} from "./proxy-constants";
import { parseExtraHeaders } from "../forward-headers";

/**
 * 过滤下游透传头：只保留合法 header 名并丢弃黑名单头
 *
 * 入参为 extractForwardableHeaders 按平台 forwardHeaders 白名单提取后的结果，
 * 本函数做第二道防线过滤（合法名正则 + FORBIDDEN_FORWARD_HEADERS 大小写不敏感）
 */
export function filterForwardHeaders(
  rawForwardHeaders: Record<string, string>
): Record<string, string> {
  const forwardHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawForwardHeaders)) {
    // 只保留合法 header 名
    if (!/^[a-zA-Z0-9-]+$/.test(k)) continue;
    // 丢弃认证类/请求语义关键头（大小写不敏感）：白名单展开在认证头与
    // extraHeaders 之前，若允许 authorization/x-api-key/content-type/host 等
    // 透传覆盖，下游客户端可替换平台密钥或破坏请求语义
    if (FORBIDDEN_FORWARD_HEADERS.has(k.toLowerCase())) continue;
    forwardHeaders[k] = v;
  }
  return forwardHeaders;
}

/** buildUpstreamFetchHeaders 入参（平台级配置按需展开，避免耦合具体平台类型） */
export interface UpstreamHeaderOptions {
  /** 当前使用的平台上游 Key 明文 */
  platformKey: string;
  /** 上游是否为 Anthropic 协议（官方 Anthropic / GitHub Copilot / Vercel AI 网关等） */
  upstreamIsAnthropic: boolean;
  /** Content-Type：multipart 请求必须保留原始 boundary，JSON 请求传 application/json */
  contentType: string;
  /** 已过滤的下游透传头 */
  forwardHeaders: Record<string, string>;
  /** 平台高级设置 extraHeaders 原始 JSON 文本（内部解析，强制覆盖透传头） */
  extraHeaders: string | null | undefined;
  /** 平台高级设置：UA 复用开关 */
  reuseUserAgent?: boolean;
  /** 平台高级设置：自定义 UA（reuseUserAgent 为真时优先级最高） */
  customUserAgent?: string | null;
}

/**
 * 组装上游 fetch 请求头（三端统一优先级：基础头 < 透传头 < extraHeaders < 自定义 UA）
 *
 * 返回普通对象；Pages 版可再传入 new Headers() 做 UA set（语义一致，
 * 对象键覆盖顺序与本函数返回值相同）。
 */
export function buildUpstreamFetchHeaders(opts: UpstreamHeaderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": opts.contentType,
    // Anthropic 协议上游：x-api-key + anthropic-version（extraHeaders 可覆盖为
    // Authorization 等，GitHub Copilot 等 OAuth 网关需用户自行配置）
    ...(opts.upstreamIsAnthropic
      ? { "x-api-key": opts.platformKey, "anthropic-version": "2023-06-01" }
      : { Authorization: `Bearer ${opts.platformKey}` }),
    ...opts.forwardHeaders,
    // 高级设置：自定义请求头（强制覆盖），优先级高于下游透传头
    ...parseExtraHeaders(opts.extraHeaders),
  };
  // 高级设置：UA 复用（自定义 UA 优先级最高，覆盖 extraHeaders 中的 User-Agent）
  if (opts.reuseUserAgent && opts.customUserAgent) {
    headers["User-Agent"] = opts.customUserAgent;
  }
  return headers;
}

/**
 * 构造上游请求 URL：Anthropic 协议上游统一指向 /v1/messages（请求体已在
 * 调用方转换为 Anthropic 格式），其余端点 baseUrl + 原样路径
 */
export function resolveUpstreamUrl(
  baseUrl: string,
  upstreamPath: string,
  upstreamIsAnthropic: boolean
): string {
  return upstreamIsAnthropic
    ? `${baseUrl.replace(/\/+$/, "")}/v1/messages`
    : `${baseUrl.replace(/\/+$/, "")}${upstreamPath}`;
}
