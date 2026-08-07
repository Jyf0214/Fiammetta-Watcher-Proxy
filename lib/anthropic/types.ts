/**
 * Anthropic Messages API 相关类型（仅本项目转换所需的子集）
 */

/** Anthropic 内容块（输入消息） */
export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content?: string | Array<{ type: "text"; text: string }>; is_error?: boolean }
  | { type: "thinking"; thinking: string; signature?: string };

/** Anthropic 输入消息 */
export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

/** Anthropic 工具定义 */
export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

/** Anthropic tool_choice */
export type AnthropicToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "none" }
  | { type: "tool"; name: string };

/** /v1/messages 请求体（转换输入） */
export interface AnthropicMessagesRequest {
  model: string;
  max_tokens?: number;
  messages?: AnthropicMessage[];
  system?: string | Array<{ type: "text"; text: string }>;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  metadata?: Record<string, unknown>;
  thinking?: Record<string, unknown>;
}

/** Anthropic 非流式响应消息 */
export interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  >;
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}
