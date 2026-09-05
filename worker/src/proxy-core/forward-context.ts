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
import type { PlatformType } from "../../../lib/types";

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
  /**
   * 本次请求实际使用的上游协议（来自 selectProtocolForRequest）。
   * 仅 anthropic 用 x-api-key + anthropic-version；其他协议（openai/azure/custom/gemini）
   * 一律 Bearer。
   *
   * 向后兼容：旧调用方仍可传 boolean（true = anthropic）；新代码请传 PlatformType。
   */
  upstreamProtocol: PlatformType | boolean;
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
  // 向后兼容：boolean → 协议字符串
  const protocol: PlatformType =
    typeof opts.upstreamProtocol === "boolean"
      ? opts.upstreamProtocol
        ? "anthropic"
        : "openai"
      : opts.upstreamProtocol;
  const upstreamIsAnthropic = protocol === "anthropic";

  const headers: Record<string, string> = {
    "Content-Type": opts.contentType,
    // Anthropic 协议上游：x-api-key + anthropic-version（extraHeaders 可覆盖为
    // Authorization 等，GitHub Copilot 等 OAuth 网关需用户自行配置）
    ...(upstreamIsAnthropic
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
 * 构造上游请求 URL：
 * - Anthropic 协议上游统一指向 /v1/messages（请求体已在调用方转换为 Anthropic 格式）
 * - Gemini 协议上游指向 /v1beta/models/{model}:generateContent（请求体已在调用方
 *   转换为 Gemini 格式，模型名作为 URL 段携带）。流式请求调用方需在 fetch 时
 *   额外追加 ?alt=sse 查询参数；本函数不预设以避免与已有查询参数冲突
 * - 其余端点 baseUrl + 原样路径
 *
 * @param upstreamProtocol  本次请求实际使用的协议（来自 selectProtocolForRequest）。
 *                          为保持对老调用方（仅传 boolean 标志）的向后兼容，
 *                          当传 boolean 时按历史规则处理（true = anthropic）；
 *                          推荐新调用方传 PlatformType 字符串。
 */
export function resolveUpstreamUrl(
  baseUrl: string,
  upstreamPath: string,
  upstreamProtocol: PlatformType | boolean,
  targetModel?: string | null,
  /**
   * 旧版 Gemini 标志：仅当 upstreamProtocol 为 boolean 时生效。
   * 新代码请传协议枚举（"gemini"），本参数将在 v2 移除。
   */
  legacyIsGemini: boolean = false
): string {
  // 向后兼容：把 boolean 折叠回协议字符串
  const protocol: PlatformType =
    typeof upstreamProtocol === "boolean"
      ? upstreamProtocol
        ? "anthropic"
        : legacyIsGemini
          ? "gemini"
          : "openai"
      : upstreamProtocol;

  const base = baseUrl.replace(/\/+$/, "");
  if (protocol === "anthropic") return `${base}/v1/messages`;
  if (protocol === "gemini") {
    // Gemini API 路径段：models/{model}，模型名原始透传（不做 URL 编码——Gemini
    // 模型 ID 均为 ASCII 安全字符如 gemini-2.0-flash / models/gemini-2.5-pro）
    // 严格白名单防御路径注入：即便 targetModel 来自内部 router/平台映射，
    // 一旦未来允许外部配置平台/自定义模型名，含 /、?、# 等会破坏 URL 语义。
    // 不通过白名单时直接 throw，调用方以 500 透传，避免静默落到 "unknown" 模糊化错误。
    // 流式端点必须是 :streamGenerateContent（:generateContent 文档上不接受 ?alt=sse 流式）。
    // 切换由 buildUpstreamFetchUrl 负责（同一函数三端共享），resolveUpstreamUrl 不感知
    // 流式语义——避免在该底层函数里引入"是否流式"参数把三端调用方搞乱
    const modelSegment = targetModel ?? null;
    if (!modelSegment) {
      throw new Error("Gemini 协议上游必须提供 targetModel 才能构造 URL");
    }
    if (!/^[A-Za-z0-9._:-]+$/.test(modelSegment)) {
      throw new Error(
        `Gemini 模型名含非法字符，拒绝构造上游 URL：${JSON.stringify(modelSegment)}`
      );
    }
    return `${base}/v1beta/models/${modelSegment}:generateContent`;
  }
  // azure/custom/openai 等：baseUrl + 原样路径
  return `${base}${upstreamPath}`;
}

/**
 * 在 resolveUpstreamUrl 之上叠加协议特定的鉴权/查询参数 + 流式端点路径，三端统一调用。
 *
 * - Gemini 协议：
 *   - API Key 通过查询参数 ?key=... 传递（不能用 Authorization Bearer）。
 *   - 流式端点必须用 :streamGenerateContent（Gemini 文档明确要求；
 *     :generateContent 配合 ?alt=sse 上游会返回非预期格式或 404）。
 *   - 非流式 :generateContent。
 *   - ?alt=sse 与 ?key 的相对顺序固定：流式 ?alt=sse&key=...，非流式 ?key=...。
 *   - 用 encodeURIComponent 防止 Key 含特殊字符（实测 Key 常含 + / =）。
 * - 其余协议：直接返回 resolveUpstreamUrl 的结果，鉴权由 buildUpstreamFetchHeaders 处理。
 *
 * 错误情形（Gemini 缺 targetModel / 模型名含非法字符）由 resolveUpstreamUrl throw；
 * 本函数只做字符串拼接，参数合法性由上游保证。
 */
export function buildUpstreamFetchUrl(
  baseUrl: string,
  upstreamPath: string,
  upstreamProtocol: PlatformType | boolean,
  targetModel: string,
  /** 当前使用的平台上游 Key 明文：仅 Gemini 协议会注入查询参数；其他协议忽略 */
  currentKey: string,
  /** 是否流式请求：Gemini 协议据此切换 :streamGenerateContent / :generateContent 端点与 ?alt=sse */
  isStream: boolean,
  /**
   * 旧版 Gemini 标志：仅当 upstreamProtocol 为 boolean 时生效。
   * 新代码请传 PlatformType 字符串（"gemini"），本参数将在 v2 移除。
   */
  legacyIsGemini: boolean = false
): string {
  // 向后兼容 boolean
  const protocol: PlatformType =
    typeof upstreamProtocol === "boolean"
      ? upstreamProtocol
        ? "anthropic"
        : legacyIsGemini
          ? "gemini"
          : "openai"
      : upstreamProtocol;

  // Gemini 协议在 resolveUpstreamUrl 之上做端点切换：流式 → :streamGenerateContent
  if (protocol === "gemini") {
    // 与 resolveUpstreamUrl 共享同一段白名单逻辑（这里直接重做以避免引入额外参数）
    const modelSegment = targetModel ?? null;
    if (!modelSegment) {
      throw new Error("Gemini 协议上游必须提供 targetModel 才能构造 URL");
    }
    if (!/^[A-Za-z0-9._:-]+$/.test(modelSegment)) {
      throw new Error(
        `Gemini 模型名含非法字符，拒绝构造上游 URL：${JSON.stringify(modelSegment)}`
      );
    }
    const base = baseUrl.replace(/\/+$/, "");
    const action = isStream ? "streamGenerateContent" : "generateContent";
    const upstreamUrl = `${base}/v1beta/models/${modelSegment}:${action}`;
    const keySegment = `key=${encodeURIComponent(currentKey)}`;
    return isStream
      ? `${upstreamUrl}?alt=sse&${keySegment}`
      : `${upstreamUrl}?${keySegment}`;
  }

  // 非 Gemini：走 resolveUpstreamUrl（鉴权由 buildUpstreamFetchHeaders 处理）
  return resolveUpstreamUrl(
    baseUrl,
    upstreamPath,
    upstreamProtocol,
    targetModel,
    legacyIsGemini
  );
}
