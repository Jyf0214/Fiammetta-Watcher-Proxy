/**
 * Anthropic /v1/messages 响应 → OpenAI /chat/completions 响应转换
 *
 * 用于"上游为 Anthropic 协议"的平台：上游 Anthropic 响应统一转成 OpenAI 内部格式，
 * 后续 usage 提取/日志/（可选）下游 Anthropic 再转换共用同一管线。
 *
 * - content 块：text 拼接、tool_use → tool_calls（input JSON 序列化）、thinking 丢弃
 * - stop_reason → finish_reason（end_turn→stop, max_tokens→length, tool_use→tool_calls）
 * - usage：input_tokens→prompt_tokens, output_tokens→completion_tokens
 * - model 回显下游请求的模型名（下游按请求名匹配响应）
 */

/** Anthropic stop_reason → OpenAI finish_reason */
export function mapStopReason(stopReason: string | null | undefined): string | null {
  switch (stopReason) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
    case null:
    case undefined:
      return "stop";
    default:
      return "stop";
  }
}

interface AnthropicContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

/** 转换后的 OpenAI /chat/completions 响应结构 */
export interface ConvertedChatCompletion extends Record<string, unknown> {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string | null;
    logprobs: null;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Anthropic message JSON → OpenAI chat.completion 响应
 *
 * @param anthropicBody 上游 /v1/messages 非流式响应体
 * @param requestedModel 下游请求中的模型名（回显）
 */
export function convertAnthropicResponse(
  anthropicBody: Record<string, unknown>,
  requestedModel: string
): ConvertedChatCompletion {
  const content = Array.isArray(anthropicBody.content)
    ? (anthropicBody.content as AnthropicContentBlock[])
    : [];

  let text = "";
  const toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> = [];

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    switch (block.type) {
      case "text":
        if (typeof block.text === "string") text += block.text;
        break;
      case "tool_use":
        toolCalls.push({
          id: block.id || `call_${toolCalls.length}`,
          type: "function",
          function: {
            name: typeof block.name === "string" ? block.name : "unknown",
            arguments: JSON.stringify(
              block.input && typeof block.input === "object" ? block.input : {}
            ),
          },
        });
        break;
      default:
        // thinking / image 等 OpenAI 无对应语义的块丢弃
        break;
    }
  }

  const usageRaw = (anthropicBody.usage ?? {}) as Record<string, unknown>;
  const promptTokens = Number(usageRaw.input_tokens) || 0;
  const completionTokens = Number(usageRaw.output_tokens) || 0;

  return {
    id: typeof anthropicBody.id === "string" ? anthropicBody.id : `msg_${Date.now().toString(36)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: mapStopReason(
          typeof anthropicBody.stop_reason === "string"
            ? anthropicBody.stop_reason
            : null
        ),
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}