/**
 * OpenAI SSE 流 → Anthropic SSE 事件流转换（增量状态机）
 *
 * 输入：逐条 OpenAI chat.completion.chunk 对象（已 JSON.parse）
 * 输出：Anthropic SSE 文本块（event: xxx\ndata: {...}\n\n），直接可写下游
 *
 * 事件序列：
 *   message_start → [content_block_start → content_block_delta* → content_block_stop]*
 *   → message_delta（stop_reason + output_tokens）→ message_stop
 *
 * OpenAI 侧依赖 stream_options.include_usage 注入（代理管道已处理），
 * usage chunk（无 choices）在 finish chunk 之后到达，output_tokens 取其值；
 * 上游未发 usage 时 output_tokens 落 0。
 */

import { mapFinishReason, generateAnthropicMessageId } from "./response";

interface OpenAIDelta {
  role?: string;
  content?: string | null;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface OpenAIStreamChunk {
  choices?: Array<{ delta?: OpenAIDelta; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface StreamOptions {
  /** 回显给下游的模型名（下游请求中的模型名） */
  model: string;
  /** message_start 中 usage.input_tokens 的估算值（流开始前无法获知真实值） */
  inputTokens?: number;
}

/** 把一条事件序列化为 SSE 文本块 */
function sseEvent(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class OpenAIToAnthropicStream {
  private model: string;
  private inputTokens: number;

  private started = false;
  private finished = false;
  private blockCounter = 0;
  private openText = false;
  private openToolBlocks = new Map<number, number>(); // OpenAI tool index → Anthropic 块 index
  private outputTokens = 0;
  private finishReason: string | null = null;

  constructor(options: StreamOptions) {
    this.model = options.model;
    this.inputTokens = options.inputTokens ?? 0;
  }

  /** 处理一条 OpenAI chunk，返回需要写出的 Anthropic SSE 文本（可能为空串） */
  feedChunk(chunk: Record<string, unknown>): string {
    const c = chunk as OpenAIStreamChunk;
    let out = "";

    if (c.usage && typeof c.usage.completion_tokens === "number") {
      this.outputTokens = c.usage.completion_tokens;
    }

    const choice = c.choices?.[0];
    if (!choice) return out;

    const delta = choice.delta ?? {};

    if (!this.started) {
      out += sseEvent("message_start", {
        type: "message_start",
        message: {
          id: generateAnthropicMessageId(),
          type: "message",
          role: "assistant",
          content: [],
          model: this.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: this.inputTokens, output_tokens: 0 },
        },
      });
      this.started = true;
    }

    if (typeof choice.finish_reason === "string") {
      this.finishReason = choice.finish_reason;
    }

    // 文本增量：打开/续写 text 块
    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (!this.openText) {
        out += sseEvent("content_block_start", {
          type: "content_block_start",
          index: this.blockCounter,
          content_block: { type: "text", text: "" },
        });
        this.openText = true;
        this.blockCounter++;
      }
      out += sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: this.blockCounter - 1,
        delta: { type: "text_delta", text: delta.content },
      });
    }

    // 工具调用增量：先结束已打开的文本块，再开/续写 tool_use 块
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      if (this.openText) {
        out += sseEvent("content_block_stop", {
          type: "content_block_stop",
          index: this.blockCounter - 1,
        });
        this.openText = false;
      }
      for (const tc of delta.tool_calls) {
        const key = tc.index ?? 0;
        let blockIndex = this.openToolBlocks.get(key);
        if (blockIndex === undefined) {
          out += sseEvent("content_block_start", {
            type: "content_block_start",
            index: this.blockCounter,
            content_block: {
              type: "tool_use",
              id: tc.id ?? `call_${this.blockCounter}`,
              name: tc.function?.name ?? "unknown",
              input: {},
            },
          });
          blockIndex = this.blockCounter;
          this.openToolBlocks.set(key, blockIndex);
          this.blockCounter++;
        }
        // 首个 chunk 可能同时携带 id/name 与 arguments（部分上游行为），统一输出增量
        const args = tc.function?.arguments;
        if (typeof args === "string" && args.length > 0) {
          out += sseEvent("content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "input_json_delta", partial_json: args },
          });
        }
      }
    }

    return out;
  }

  /** 流结束时收尾：关闭所有块 → message_delta → message_stop（幂等，重复调用返回空串） */
  finish(): string {
    if (this.finished) return "";
    let out = "";
    if (!this.started) { this.finished = true; return out; }

    if (this.openText) {
      out += sseEvent("content_block_stop", {
        type: "content_block_stop",
        index: this.blockCounter - 1,
      });
      this.openText = false;
    }
    for (const blockIndex of this.openToolBlocks.values()) {
      out += sseEvent("content_block_stop", {
        type: "content_block_stop",
        index: blockIndex,
      });
    }
    this.openToolBlocks.clear();

    out += sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: mapFinishReason(this.finishReason), stop_sequence: null },
      usage: { output_tokens: this.outputTokens },
    });
    // usage 事件：提供完整的 token 使用统计（input + output），
    // Anthropic SDK 客户端依赖此事件获取真实的 input_tokens 覆盖 message_start 中的估算值
    out += sseEvent("usage", {
      type: "usage",
      input_tokens: this.inputTokens,
      output_tokens: this.outputTokens,
    });
    out += sseEvent("message_stop", { type: "message_stop" });
    this.finished = true;
    return out;
  }
}
