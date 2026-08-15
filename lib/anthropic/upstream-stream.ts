/**
 * Anthropic SSE 流 → OpenAI SSE chunk 流转换（增量状态机）
 *
 * 输入：逐条 Anthropic /v1/messages 事件 data 对象（已 JSON.parse）
 * 输出：OpenAI chat.completion.chunk 形状的 SSE 文本，直接可写下游
 *
 * 事件序列映射：
 *   message_start → 首 chunk（delta.role）
 *   content_block_start(tool_use) → 记录 id/name，首个 input_json_delta 时随 arguments 发出
 *   content_block_delta(text_delta) → delta.content
 *   content_block_delta(input_json_delta) → delta.tool_calls 增量
 *   message_delta → finish chunk（stop_reason 映射）
 *   message_stop → usage chunk + data: [DONE]
 *   error → OpenAI 形状 error chunk（Anthropic 错误类型映射 HTTP 码），不输出 [DONE]
 *
 * 流被截断（EOF 无 message_stop）时不输出 [DONE]：下游 usage 管线据此判定
 * 截断并触发熔断，与 OpenAI 上游语义一致。
 */

import { mapStopReason } from "./upstream-response";

interface AnthropicStreamData {
  type?: string;
  message?: {
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  usage?: { output_tokens?: number };
  error?: { type?: string; message?: string };
  index?: number;
}

/** Anthropic 错误类型 → HTTP 状态码（供下游 usage 管线识别流内失败） */
export function mapAnthropicErrorType(
  errorType: string | undefined
): number {
  switch (errorType) {
    case "overloaded_error":
      return 529;
    case "rate_limit_error":
      return 429;
    case "authentication_error":
      return 401;
    case "permission_error":
      return 403;
    case "not_found_error":
      return 404;
    case "invalid_request_error":
      return 400;
    case "api_error":
      return 500;
    case "timeout_error":
    case "connection_error":
      return 504;
    default:
      return 500;
  }
}

/** 把一条事件序列化为 OpenAI SSE 文本 */
function chunkEvent(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export class AnthropicToOpenAIStream {
  private inputTokens = 0;
  private outputTokens = 0;
  private finishReason: string | null = null;

  private started = false;
  private finished = false;
  private errored = false;
  /** tool_use 块 index → { id, name }，首个 input_json_delta 时随 arguments 发出 */
  private pendingTools = new Map<number, { id: string; name: string }>();

  /** 处理一条 Anthropic 事件 data，返回需要写出的 OpenAI SSE 文本（可能为空串） */
  feedData(data: Record<string, unknown>): string {
    if (this.errored || this.finished) return "";
    const d = data as AnthropicStreamData;
    let out = "";

    switch (d.type) {
      case "message_start": {
        this.inputTokens = d.message?.usage?.input_tokens ?? 0;
        // OpenAI 首 chunk 携带 role；不占用 content 增量
        out += chunkEvent({
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        });
        this.started = true;
        break;
      }
      case "content_block_start": {
        const block = d.content_block;
        if (block?.type === "tool_use" && typeof d.index === "number") {
          this.pendingTools.set(d.index, {
            id: block.id || `call_${d.index}`,
            name: block.name || "unknown",
          });
        }
        break;
      }
      case "content_block_delta": {
        const delta = d.delta;
        if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
          out += chunkEvent({
            choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }],
          });
        } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const toolIndex = typeof d.index === "number" ? d.index : 0;
          const pending = this.pendingTools.get(toolIndex);
          let toolDelta: Record<string, unknown> = {
            index: toolIndex,
            function: { arguments: delta.partial_json },
          };
          if (pending) {
            // 首个增量携带 id/name（OpenAI 流式工具调用规范）
            toolDelta = {
              index: toolIndex,
              id: pending.id,
              type: "function",
              function: { name: pending.name, arguments: delta.partial_json },
            };
            this.pendingTools.delete(toolIndex);
          }
          out += chunkEvent({
            choices: [
              { index: 0, delta: { tool_calls: [toolDelta] }, finish_reason: null },
            ],
          });
        }
        break;
      }
      case "message_delta": {
        const delta = d.delta;
        if (typeof delta?.stop_reason === "string") {
          this.finishReason = delta.stop_reason;
        }
        if (typeof d.usage?.output_tokens === "number") {
          this.outputTokens = d.usage.output_tokens;
        }
        out += chunkEvent({
          choices: [
            { index: 0, delta: {}, finish_reason: mapStopReason(this.finishReason) },
          ],
        });
        break;
      }
      case "message_stop": {
        // OpenAI 惯例：usage chunk（无 choices）在 finish 之后、[DONE] 之前
        out += chunkEvent({
          usage: {
            prompt_tokens: this.inputTokens,
            completion_tokens: this.outputTokens,
            total_tokens: this.inputTokens + this.outputTokens,
          },
        });
        out += "data: [DONE]\n\n";
        this.finished = true;
        break;
      }
      case "error": {
        const err = d.error;
        out += chunkEvent({
          error: {
            code: mapAnthropicErrorType(err?.type),
            message: String(err?.message || "上游 Anthropic 服务返回错误").substring(0, 500),
          },
        });
        this.errored = true;
        break;
      }
      default:
        // ping 等无内容事件忽略
        break;
    }

    return out;
  }

  /** 流 EOF 收尾：未正常结束（无 message_stop）时不输出 [DONE]，交由下游判定截断 */
  finish(): string {
    if (this.finished || this.errored) return "";
    this.finished = true;
    return "";
  }
}