/**
 * OpenAI /chat/completions 响应 → Anthropic /v1/messages 响应转换
 *
 * - content（string | part 数组）→ text 块（多段拼接）
 * - tool_calls → tool_use 块（arguments JSON 解析）
 * - finish_reason → stop_reason（stop→end_turn, length→max_tokens, tool_calls→tool_use）
 * - usage：prompt_tokens→input_tokens, completion_tokens→output_tokens
 * - model 回显下游请求的模型名（下游按请求名匹配响应）
 */

import type { AnthropicMessageResponse } from "./types";

/** OpenAI finish_reason → Anthropic stop_reason */
export function mapFinishReason(finishReason: string | null | undefined): string | null {
  switch (finishReason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "stop":
    case "content_filter":
    case null:
    case undefined:
      return "end_turn";
    default:
      return "end_turn";
  }
}

/** 生成 Anthropic 风格消息 ID */
export function generateAnthropicMessageId(): string {
  const rand = Math.random().toString(36).slice(2, 14);
  return `msg_${Date.now().toString(36)}${rand}`;
}

interface OpenAIChatCompletion {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }> | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * OpenAI chat.completion JSON → Anthropic message 响应
 *
 * @param openaiBody 上游 /chat/completions 非流式响应体
 * @param requestedModel 下游请求中的模型名（回显）
 */
export function convertOpenAIResponse(
  openaiBody: Record<string, unknown>,
  requestedModel: string
): AnthropicMessageResponse {
  const completion = openaiBody as OpenAIChatCompletion;
  const choice = completion.choices?.[0];

  const contentBlocks: AnthropicMessageResponse["content"] = [];
  const rawContent = choice?.message?.content;
  let text = "";
  if (typeof rawContent === "string") {
    text = rawContent;
  } else if (Array.isArray(rawContent)) {
    text = rawContent
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("");
  }
  if (text) {
    contentBlocks.push({ type: "text", text });
  }

  for (const toolCall of choice?.message?.tool_calls ?? []) {
    let input: Record<string, unknown>;
    try {
      const parsed = JSON.parse(toolCall.function?.arguments || "{}") as unknown;
      // Anthropic tool_use 的 input 必须是对象：字符串/数字等病态值回退空对象
      input = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      input = {};
    }
    contentBlocks.push({
      type: "tool_use",
      id: toolCall.id || `call_${contentBlocks.length}`,
      name: toolCall.function?.name || "unknown",
      input,
    });
  }

  return {
    id: generateAnthropicMessageId(),
    type: "message",
    role: "assistant",
    content: contentBlocks,
    model: requestedModel,
    stop_reason: mapFinishReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: completion.usage?.prompt_tokens ?? 0,
      output_tokens: completion.usage?.completion_tokens ?? 0,
    },
  };
}
