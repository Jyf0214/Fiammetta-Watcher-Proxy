/**
 * Gemini 流式响应（?alt=sse）→ OpenAI 流式响应（SSE）转换
 *
 * Gemini :streamGenerateContent 启用 ?alt=sse 时每行格式：
 *   data: {candidates:[{content:{parts:[{text:"..."}],role:"model"}, finishReason:"..."}], usageMetadata:{...}}\n
 *   行间有空行（SSE 规范）。
 *
 * 转换目标（OpenAI ChatCompletionChunk）：
 *   data: {id, object:"chat.completion.chunk", created, model, choices:[{index, delta:{role?, content?, tool_calls?}, finish_reason?}]}\n
 *   终止行：data: [DONE]
 *
 * PR-B 限制：
 * - 仅 text 与 functionCall 两类 part；thought / inline_data 忽略
 * - usageMetadata 仅在 Gemini 流末出现时输出 OpenAI usage（无独立 chunk 事件）
 * - 行解析失败时跳过该行（容错优先，避免一个坏包阻断整流）
 */

import type { GeminiGenerateContentResponse, GeminiPart } from "./types";
import { mapGeminiFinishReason, GeminiResponseError } from "./upstream-response";

/** OpenAI 流 chunk 形状（仅本转换器产出字段） */
export interface OpenAIStreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: "assistant";
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: "stop" | "length" | "tool_calls" | "content_filter" | "function_call" | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** 把单条 Gemini 流片段转 OpenAI chunk（不写 SSE 协议头） */
export function convertGeminiStreamChunkToOpenAI(
  input: GeminiGenerateContentResponse,
  modelHint: string,
  chunkId: string,
  chunkCreated: number
): OpenAIStreamChunk | null {
  const candidates = Array.isArray(input.candidates) ? input.candidates : [];
  if (candidates.length === 0) {
    // 末次响应可能只含 usageMetadata；该情况由调用方专门输出 usage chunk
    return null;
  }
  const choices = candidates.map((c, i) => {
    const delta: OpenAIStreamChunk["choices"][number]["delta"] = {};
    const parts: GeminiPart[] = c.content?.parts ?? [];
    const textParts: string[] = [];
    const toolCalls: OpenAIStreamChunk["choices"][number]["delta"]["tool_calls"] = [];
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p];
      if ("text" in part) {
        textParts.push(part.text);
      } else if ("functionCall" in part) {
        toolCalls!.push({
          index: p,
          id: `call_${part.functionCall.name}_${p}`,
          type: "function",
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args),
          },
        });
      }
    }
    if (textParts.length > 0) delta.content = textParts.join("");
    if (toolCalls && toolCalls.length > 0) delta.tool_calls = toolCalls;
    // 首条 chunk 注入 role
    if (i === 0 && (delta.content !== undefined || (delta.tool_calls && delta.tool_calls.length > 0))) {
      delta.role = "assistant";
    }
    const finishReason = c.finishReason
      ? mapGeminiFinishReason(c.finishReason)
      : null;
    return {
      index: i,
      delta,
      finish_reason: finishReason,
    };
  });
  return {
    id: chunkId,
    object: "chat.completion.chunk",
    created: chunkCreated,
    model: modelHint || input.modelVersion || "gemini",
    choices,
  };
}

/** 把 usageMetadata 转独立的 usage chunk（OpenAI 兼容） */
export function buildOpenAIUsageChunk(
  input: GeminiGenerateContentResponse,
  chunkId: string,
  chunkCreated: number,
  modelHint: string
): OpenAIStreamChunk | null {
  if (!input.usageMetadata) return null;
  return {
    id: chunkId,
    object: "chat.completion.chunk",
    created: chunkCreated,
    model: modelHint || input.modelVersion || "gemini",
    choices: [],
    usage: {
      prompt_tokens: input.usageMetadata.promptTokenCount ?? 0,
      completion_tokens: input.usageMetadata.candidatesTokenCount ?? 0,
      total_tokens:
        input.usageMetadata.totalTokenCount ??
        (input.usageMetadata.promptTokenCount ?? 0) +
          (input.usageMetadata.candidatesTokenCount ?? 0),
    },
  };
}

/** 行解析入口：接收一行 SSE data（不含 "data: " 前缀），返回 0/1/2 个 OpenAI chunk */
export function parseGeminiStreamLine(
  line: string,
  modelHint: string,
  chunkId: string,
  chunkCreated: number
): { contentChunk: OpenAIStreamChunk | null; usageChunk: OpenAIStreamChunk | null; error: string | null } {
  const trimmed = line.trim();
  if (!trimmed) return { contentChunk: null, usageChunk: null, error: null };
  if (trimmed === "[DONE]") return { contentChunk: null, usageChunk: null, error: null };
  let parsed: GeminiGenerateContentResponse;
  try {
    parsed = JSON.parse(trimmed) as GeminiGenerateContentResponse;
  } catch (e) {
    return {
      contentChunk: null,
      usageChunk: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  // 顶层安全拦截：抛错让调用方决定如何转为终止事件
  if (parsed.promptFeedback?.blockReason) {
    return {
      contentChunk: null,
      usageChunk: null,
      error: `Gemini prompt blocked: ${parsed.promptFeedback.blockReason}`,
    };
  }
  return {
    contentChunk: convertGeminiStreamChunkToOpenAI(parsed, modelHint, chunkId, chunkCreated),
    usageChunk: buildOpenAIUsageChunk(parsed, chunkId, chunkCreated, modelHint),
    error: null,
  };
}

/** 重新导出响应错误类以便外部 import */
export { GeminiResponseError };

/**
 * Gemini SSE → OpenAI SSE TransformStream
 *
 * 接收 Gemini :streamGenerateContent?alt=sse 的字节流（UTF-8），按行解析
 * `data: {JSON}` 事件，转换为 OpenAI chat.completion.chunk + 终止 [DONE]，
 * 编码为 `data: {JSON}\n\n` 字节输出。
 *
 * PR-B 限制：
 * - 仅 text + functionCall 两类 part；thought / inline_data 忽略
 * - usageMetadata 仅在末次响应出现时输出 OpenAI usage chunk
 * - 行解析失败时丢弃（容错优先）但继续处理后续行
 *
 * 使用：geminiUpstreamBody.pipeThrough(createGeminiStreamToOpenAITransformer(modelHint))
 */
export function createGeminiStreamToOpenAITransformer(
  modelHint: string
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder("utf-8");
  const encoder = new TextEncoder();
  const chunkCreated = Math.floor(Date.now() / 1000);
  // 自增 id 起点（每条 chunk 用 chunkId 字段）
  let chunkSeq = 0;
  const chunkId = `gemini-${chunkCreated}`;

  // 行缓冲：可能一次 read 拿到不完整的 "data: {...\n\n" 跨 chunk 边界
  let buffer = "";

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      // SSE 事件以双换行 "\n\n" 分隔，按行处理 "data: ..." 行
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const lineRaw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const line = lineRaw.trim();
        if (!line) continue; // 空行（SSE 事件分隔符）
        if (line === "[DONE]") {
          // Gemini 不会发 [DONE]，但保留兼容性
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          continue;
        }
        // 只处理 data: 前缀
        const dataMatch = line.match(/^data:\s?(.*)$/);
        if (!dataMatch) continue;
        const jsonPart = dataMatch[1];
        chunkSeq += 1;
        const { contentChunk, usageChunk, error } = parseGeminiStreamLine(
          jsonPart,
          modelHint,
          chunkId,
          chunkCreated + chunkSeq
        );
        if (error) {
          // 解析失败：丢弃本行继续流（容错优先于中断）
          // 顶层安全拦截时直接终止流（避免静默吞掉 promptFeedback.blockReason）
          if (error.startsWith("Gemini prompt blocked")) {
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ error: { message: error, type: "invalid_request_error" } })}\n\n`
            ));
            controller.terminate();
            return;
          }
          continue;
        }
        if (contentChunk) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentChunk)}\n\n`));
        }
        if (usageChunk) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(usageChunk)}\n\n`));
        }
      }
    },
    flush(controller) {
      // 收尾处理：处理缓冲区残留（最后一个 chunk 可能没有 \n 结尾）
      buffer += decoder.decode();
      const tail = buffer.trim();
      if (tail && tail !== "[DONE]") {
        const dataMatch = tail.match(/^data:\s?(.*)$/);
        if (dataMatch) {
          chunkSeq += 1;
          const { contentChunk, usageChunk } = parseGeminiStreamLine(
            dataMatch[1],
            modelHint,
            chunkId,
            chunkCreated + chunkSeq
          );
          if (contentChunk) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentChunk)}\n\n`));
          }
          if (usageChunk) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(usageChunk)}\n\n`));
          }
        }
      }
      // OpenAI 终止事件
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    },
  });
}
