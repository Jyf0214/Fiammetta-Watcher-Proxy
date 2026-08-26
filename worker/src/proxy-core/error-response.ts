/**
 * 代理错误响应构造核心（proxy-core 第二块）
 *
 * 三入口（worker/src/proxy.ts 全量版 v1ErrorResponse、worker/src/proxy-lite.ts
 * lite 版 liteErrorResponse、pages/api/v1/[[...v1]].ts Pages 版 sendV1Error）
 * 此前各自内联实现了同一段错误体构造，三份实现逐字相同：
 * - anthropic 协议：formatAnthropicError(status, message, type)；
 * - openai 协议：{ error: { message, type, ...extra } }；状态码两协议保持一致。
 * 本模块把该语义固化为唯一实现，输出「状态码 + 序列化响应体 + 内容类型」，
 * 由各入口以各自的传输方式下发（Worker 用 Response.json / Pages 用
 * res.status().json()），后续批次接入后内联函数即可删除。
 *
 * 语义契约（逐条对齐三端现状）：
 * 1. 状态码两协议保持一致（三端注释原文：「状态码两边保持一致」）；
 * 2. anthropic 分支复用 lib/anthropic 的 formatAnthropicError（import 复用，
 *    不复制实现），type 作为其 openaiType 提示参数原样传入——与三端现状一致；
 * 3. openai 分支体结构固定为 { error: { message, type, retry_after? } }：
 *    键序 message → type → 附加字段，与 { error: { message, type, ...extra } }
 *    的展开序逐字节一致。extra 在调用方的唯一实际用键是 retry_after（429 门禁
 *    拒绝时由调用方 Math.ceil 换算秒后传入，本模块不做二次取整、原样透出；
 *    lite 版现无任何带 extra 的调用点）；
 *    sanitizeUpstreamError 输出的 upstream_status 属于另一条独立的内联透传
 *    路径（不经 v1ErrorResponse/sendV1Error），不在本模块契约内；
 * 4. 文案零归一化：message 调用方传什么就是什么，不做截断/trim/改写；
 * 5. anthropic 体无法表达附加字段（formatAnthropicError 无此参数），三端现状
 *    即丢弃 extra——retryAfterSeconds 在 anthropic 分支同样被忽略，非行为变更；
 * 6. type 缺省（或空字符串）时按 status 默认映射，复用 lib/anthropic 已有的
 *    toAnthropicErrorType 单一映射表，不新造平行表。空字符串与缺省同义，与
 *    toAnthropicErrorType 对空 openaiType 的处理一致。三端现有调用点全部显式
 *    传 type，缺省映射不改变任何现有行为；
 * 7. 参数非法时显式抛错（协议未知 / 状态码非整数或越界 / message 非字符串 /
 *    retryAfterSeconds 提供但非有限数值）：内联现状对此会静默产出残缺 JSON
 *    （如 JSON.stringify 丢弃 undefined 键），共享层选择报错而非糊弄。
 */

import { formatAnthropicError, toAnthropicErrorType } from "@/lib/anthropic";

/** 三端代理错误响应的公共负载：调用方按各自传输方式下发 */
export interface ProxyErrorPayload {
  /** HTTP 状态码：openai/anthropic 两协议保持一致（三端现状语义） */
  status: number;
  /** JSON.stringify 后的响应体文本（键序与三端现有输出逐字节一致） */
  body: string;
  /** 三端现有下发方式（Response.json / res.json()）均为 application/json */
  contentType: "application/json";
}

/** buildProxyError 入参 */
export interface BuildProxyErrorOptions {
  /** 下游客户端协议语义（对应三端 ProxyConfig.protocol） */
  protocol: "openai" | "anthropic";
  /** 对外返回的 HTTP 状态码 */
  status: number;
  /** 错误文案：零归一化，原样进入响应体 */
  message: string;
  /**
   * openai 协议的 error.type；缺省（或空字符串）时按 status 经
   * toAnthropicErrorType 默认映射。anthropic 协议下作为 openaiType 提示
   * 原样传入 formatAnthropicError（由其内部决定最终 error.type）。
   */
  type?: string;
  /**
   * Retry-After 提示秒数（429 门禁拒绝场景）：存在时 openai 体附加扁平键
   * retry_after（值原样透出，取整由调用方负责）；anthropic 分支忽略该字段
   * （三端现状即丢弃 extra）。传 undefined 视为未提供，传其他非有限数值报错。
   */
  retryAfterSeconds?: number;
}

/**
 * 按协议构造代理错误响应负载
 *
 * 编排语义见文件头「语义契约」。纯函数：无 I/O、无副作用、不改写入参。
 */
export function buildProxyError(opts: BuildProxyErrorOptions): ProxyErrorPayload {
  // ── 参数显式校验（契约第 7 条）：缺失/非法即抛错，拒绝产出残缺响应体 ──
  if (opts.protocol !== "openai" && opts.protocol !== "anthropic") {
    throw new TypeError(`protocol 必须为 "openai" 或 "anthropic"，收到: ${String(opts.protocol)}`);
  }
  if (!Number.isInteger(opts.status) || opts.status < 100 || opts.status > 999) {
    throw new RangeError(`status 必须为三位数 HTTP 状态码整数，收到: ${String(opts.status)}`);
  }
  if (typeof opts.message !== "string") {
    throw new TypeError(`message 必须为字符串，收到: ${typeof opts.message}`);
  }
  if (
    opts.retryAfterSeconds !== undefined &&
    (typeof opts.retryAfterSeconds !== "number" || !Number.isFinite(opts.retryAfterSeconds))
  ) {
    throw new TypeError(`retryAfterSeconds 提供时必须为有限数值，收到: ${String(opts.retryAfterSeconds)}`);
  }

  // ── anthropic 协议：复用 lib/anthropic 共享实现（契约第 2 条），type 原样透传 ──
  if (opts.protocol === "anthropic") {
    return {
      status: opts.status,
      body: JSON.stringify(formatAnthropicError(opts.status, opts.message, opts.type)),
      contentType: "application/json",
    };
  }

  // ── openai 协议：{ error: { message, type, retry_after? } } ──
  // type 缺省/空串 → 按 status 默认映射（契约第 6 条）
  const hasExplicitType = typeof opts.type === "string" && opts.type.length > 0;
  const type = hasExplicitType ? (opts.type as string) : toAnthropicErrorType(opts.status);

  // 键序 message → type → retry_after，与 { message, type, ...extra } 展开序一致
  const error: Record<string, unknown> = { message: opts.message, type };
  if (opts.retryAfterSeconds !== undefined) {
    error.retry_after = opts.retryAfterSeconds;
  }
  return {
    status: opts.status,
    body: JSON.stringify({ error }),
    contentType: "application/json",
  };
}
