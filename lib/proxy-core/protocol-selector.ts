/**
 * 单平台多协议 — 在平台的 types[] 数组中挑选本次请求实际使用的协议
 *
 * 三端（Worker 全量 / Worker lite / Pages v1）共用同一选择算法，避免行为漂移。
 *
 * 选择规则（按优先级匹配）：
 * 1. 下游端点是 /v1/messages（Anthropic 原生协议入口）→ 在 types 中找 anthropic
 * 2. 下游端点是 /v1/responses（OpenAI Responses 入口）→ 在 types 中找 openai
 * 3. 下游端点是 /v1/chat/completions 或其他 OpenAI 兼容 → 在 types 中找 openai
 * 4. 目标模型名疑似 Gemini（gemini- 前缀或 models/ 命名空间）→ 在 types 中找 gemini
 * 5. 全部不匹配 → 返回 types[0]（即首选协议 = type，向后兼容）
 *
 * 入参：
 * - types：平台支持的协议列表（旧数据缺失时由 resolvePlatformProtocols 回退为 [type]）
 * - upstreamPath：下游请求端点（/v1/messages / /v1/chat/completions / /v1/responses）
 * - targetModel：路由选定的目标模型名（用于 Gemini 模型名启发式匹配）
 *
 * 返回：本次请求应使用的协议（PlatformType）；types 为空时返回 "openai"（保底）。
 *
 * 注意：本函数只决定协议；上游 URL 构造、请求体/响应转换由调用方按返回的协议分支处理。
 */

import type { PlatformProtocol, PlatformType } from "../types";

/**
 * 端点 → 协议偏好的映射：每个下游端点对应的「理想协议」。
 * 找不到理想协议时退而求其次（如 /v1/messages 的请求落到 openai 兼容上游，
 * 由调用方决定是否转换——本函数只选最匹配的协议，不做转换语义判断）。
 */
const ENDPOINT_PREFERRED_PROTOCOL: ReadonlyArray<readonly [RegExp, PlatformType]> = [
  [/\/v1\/messages(?:\/|$|\?)/, "anthropic"],
  [/\/v1\/responses(?:\/|$|\?)/, "openai"],
  [/\/v1\/chat\/completions(?:\/|$|\?)/, "openai"],
];

/** Gemini 模型名启发式：gemini- 前缀或 models/gemini- 命名空间 */
const GEMINI_MODEL_PATTERN = /^(?:models\/)?gemini-[\w.-]+$/i;

export interface SelectProtocolOptions {
  types: readonly PlatformProtocol[];
  upstreamPath: string;
  targetModel: string;
}

/**
 * 在 types 中按优先级挑选协议。
 *
 * 设计要点：
 * - 必须返回 types 内的一个值（保证下游所有转换分支都有对应代码路径可走），
 *   不会返回 types 外的协议，避免出现「平台不支持的协议被误用」的情况。
 * - 当 types 缺失或非法时回退到 "openai"（最广泛的 OpenAI 兼容默认）。
 */
export function selectProtocolForRequest(
  opts: SelectProtocolOptions
): PlatformType {
  const { types, upstreamPath, targetModel } = opts;

  // 模型名启发式优先级最高：客户端请求的就是 Gemini 模型，平台又支持 gemini，
  // 应当无视端点（用户可能用 OpenAI 兼容端点代理 Gemini 直连场景）走 gemini
  if (
    GEMINI_MODEL_PATTERN.test(targetModel) &&
    types.includes("gemini")
  ) {
    return "gemini";
  }

  // 端点 → 协议偏好
  for (const [pattern, preferred] of ENDPOINT_PREFERRED_PROTOCOL) {
    if (pattern.test(upstreamPath) && types.includes(preferred)) {
      return preferred;
    }
  }

  // 兜底：types 第一项（首选协议 = type）
  return types[0] ?? "openai";
}
