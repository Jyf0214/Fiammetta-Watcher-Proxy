/**
 * V1 端点配置表（全量版与 lite 版 Worker 共用）
 *
 * 从 URL 路径解析出端点配置（上游路径、是否支持流式、Anthropic 协议标记等），
 * 避免 v1-route 与 v1-route-lite 各自维护一份导致漂移。
 */

import { convertAnthropicRequest } from "@/lib/anthropic";

export interface ProxyConfig {
  /** 上游路径，如 "/chat/completions"、"/embeddings" */
  upstreamPath: string;
  /** 是否支持流式响应 */
  supportsStreaming?: boolean;
  /** 允许的模型类型 */
  allowedModelTypes?: string[];
  /** 代理协议：anthropic 时做 /v1/messages ↔ /chat/completions 双向转换 */
  protocol?: "openai" | "anthropic";
  /** 额外的请求体校验 */
  validateBody?: (body: Record<string, unknown>) => Response | null;
  /** 构建上游请求体（Anthropic 分支在解析后立即调用，把下游格式转为 OpenAI 格式） */
  buildUpstreamBody?: (
    body: Record<string, unknown>
  ) => Record<string, unknown>;
}

/**
 * 根据路径确定端点配置
 */
export function getEndpointConfig(pathname: string): ProxyConfig | null {
  const endpoint = pathname.replace(/^\/v1/, "");

  switch (endpoint) {
    case "/chat/completions":
      return { upstreamPath: "/chat/completions", supportsStreaming: true };
    case "/completions":
      return { upstreamPath: "/completions", supportsStreaming: true };
    case "/embeddings":
      return { upstreamPath: "/embeddings", supportsStreaming: false };
    case "/images/generations":
      return { upstreamPath: "/images/generations", supportsStreaming: false };
    case "/images/edits":
      return { upstreamPath: "/images/edits", supportsStreaming: false };
    case "/images/variations":
      return { upstreamPath: "/images/variations", supportsStreaming: false };
    case "/audio/speech":
      return { upstreamPath: "/audio/speech", supportsStreaming: false };
    case "/audio/transcriptions":
      return { upstreamPath: "/audio/transcriptions", supportsStreaming: false };
    case "/audio/translations":
      return { upstreamPath: "/audio/translations", supportsStreaming: false };
    case "/responses":
      return { upstreamPath: "/responses", supportsStreaming: true };
    case "/models":
      return { upstreamPath: "/models", supportsStreaming: false };
    case "/messages":
      return {
        upstreamPath: "/chat/completions",
        supportsStreaming: true,
        protocol: "anthropic",
        buildUpstreamBody: convertAnthropicRequest,
      };
    default:
      if (endpoint.startsWith("/models/")) {
        return { upstreamPath: endpoint, supportsStreaming: false };
      }
      return null;
  }
}
