/**
 * Gemini GenerateContent 响应 → OpenAI /chat/completions 响应转换
 *
 * 转换规则（PR-B 最小骨架）：
 * - candidates[0].content.parts[].text → message.content
 * - candidates[0].content.parts[].functionCall → tool_calls[]（合并多 call）
 * - candidates[0].finishReason → OpenAI finish_reason（STOP→stop, MAX_TOKENS→length, 其他→stop）
 * - usageMetadata.{promptTokenCount, candidatesTokenCount, totalTokenCount} →
 *   usage.{prompt_tokens, completion_tokens, total_tokens}
 * - promptFeedback.blockReason 出现时映射为 400 invalid_request_error
 *
 * 不在范围（后续 PR）：多模态 file_data/inline_data 透传、thought part 处理、
 * safetyRatings 拦截、cachedContentTokenCount/thoughtsTokenCount 拆分。
 */

import type {
  GeminiCandidate,
  GeminiGenerateContentResponse,
  GeminiPart,
} from "./types";

/** OpenAI chat.completions 响应（仅本转换器关心的子集）
 *
 * extends Record<string, unknown> 以兼容 proxy.ts 中将 openaiBody 赋给
 * Record<string, unknown> | null 的赋值场景（具体类型没有 index signature
 * 时 strict 模式会报 TS2322）。anthropic 端的 ConvertedChatCompletion
 * 用同样模式处理。 */
export interface OpenAIChatResponse extends Record<string, unknown> {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | "function_call";
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** 把 Gemini finishReason 映射到 OpenAI finish_reason */
export function mapGeminiFinishReason(
  reason: GeminiCandidate["finishReason"]
): OpenAIChatResponse["choices"][number]["finish_reason"] {
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
      return "content_filter";
    case "OTHER":
    case "FINISH_REASON_UNSPECIFIED":
    case undefined:
    default:
      return "stop";
  }
}

/** 从 candidate.content.parts[] 抽 text + functionCall，分两类产出 */
interface ExtractedParts {
  text: string;
  toolCalls: Array<{
    name: string;
    args: Record<string, unknown>;
  }>;
}

function extractParts(parts: GeminiPart[] | undefined): ExtractedParts {
  const textParts: string[] = [];
  const toolCalls: ExtractedParts["toolCalls"] = [];
  if (!parts) return { text: "", toolCalls };
  for (const p of parts) {
    if ("text" in p) {
      textParts.push(p.text);
    } else if ("functionCall" in p) {
      toolCalls.push({ name: p.functionCall.name, args: p.functionCall.args });
    }
    // functionResponse / thought / inline_data / file_data 暂忽略（PR-B 不支持）
  }
  return { text: textParts.join(""), toolCalls };
}

function buildToolCallId(name: string, index: number): string {
  // Gemini 不返回 tool_call_id；OpenAI 客户端通常以 name+index 识别。
  // 简单合成：call_<name>_<index>，客户端拿到可作稳定标识。
  return `call_${name}_${index}`;
}

/** 单个 Gemini candidate → OpenAI choice */
function candidateToChoice(candidate: GeminiCandidate, index: number) {
  const { text, toolCalls } = extractParts(candidate.content?.parts);
  const message: OpenAIChatResponse["choices"][number]["message"] = {
    role: "assistant",
    content: text.length > 0 ? text : null,
  };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((tc, i) => ({
      id: buildToolCallId(tc.name, i),
      type: "function" as const,
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.args),
      },
    }));
  }
  return {
    index,
    message,
    finish_reason: toolCalls.length > 0
      ? "tool_calls" as const
      : mapGeminiFinishReason(candidate.finishReason),
  };
}

/**
 * Gemini GenerateContentResponse → OpenAI /chat/completions 响应。
 * 异常输入（如空 candidates）抛 GeminiResponseError，由调用方以 OpenAI error 格式响应。
 */
export class GeminiResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiResponseError";
  }
}

export function convertGeminiToOpenAIResponse(
  input: GeminiGenerateContentResponse,
  modelHint: string
): OpenAIChatResponse {
  // 顶层安全拦截：promptFeedback.blockReason 非空时拒绝
  if (input.promptFeedback?.blockReason) {
    throw new GeminiResponseError(
      `Gemini prompt blocked: ${input.promptFeedback.blockReason}`
    );
  }
  const candidates = Array.isArray(input.candidates) ? input.candidates : [];
  if (candidates.length === 0) {
    throw new GeminiResponseError("Gemini 响应无 candidates");
  }
  const choices = candidates.map((c, i) => candidateToChoice(c, i));

  const out: OpenAIChatResponse = {
    id: `gemini-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelHint || input.modelVersion || "gemini",
    choices,
  };
  if (input.usageMetadata) {
    out.usage = {
      prompt_tokens: input.usageMetadata.promptTokenCount ?? 0,
      completion_tokens: input.usageMetadata.candidatesTokenCount ?? 0,
      total_tokens: input.usageMetadata.totalTokenCount ??
        (input.usageMetadata.promptTokenCount ?? 0) +
        (input.usageMetadata.candidatesTokenCount ?? 0),
    };
  }
  return out;
}
