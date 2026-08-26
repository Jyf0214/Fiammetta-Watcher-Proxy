/**
 * SSE 协议转换器核心（proxy-core 第八块）
 *
 * worker/src/proxy.ts 全量版与 worker/src/proxy-lite.ts lite 版此前各自内联
 * 实现了同一对 TransformStream：
 * - createAnthropicStreamTransformer：OpenAI SSE → Anthropic SSE（Anthropic
 *   协议下游分支专用，接在 usage 提取之后；流内 error 转发为 event: error，
 *   正常收尾由 OpenAIToAnthropicStream.finish 输出）；
 * - createOpenAIStreamTransformer：Anthropic SSE → OpenAI SSE（上游为
 *   Anthropic 协议时专用，接在 usage 提取之前，正常收尾补发 data: [DONE]）。
 *
 * 统一化行为收敛：全量版此前在流内 error 分支手写错误码解析（number 或可
 * parseInt 的字符串才视为错误码），lite 版用 token.ts 的 resolveStreamErrorStatus
 * （含非数字枚举如 Azure "content_filter" 兜底 502）。本模块统一采用
 * resolveStreamErrorStatus——「上游 200 + 流内不可解析错误码」在全量版曾被
 * 静默忽略、客户端拿到无收尾的悬挂流，统一后按 502 记失败并下发 event: error。
 */

import {
  OpenAIToAnthropicStream,
  AnthropicToOpenAIStream,
  formatAnthropicError,
} from "@/lib/anthropic";
import { resolveStreamErrorStatus } from "../token";

/**
 * OpenAI SSE → Anthropic SSE 的 TransformStream（Anthropic 协议分支专用）
 *
 * 接在 usage 提取转换器之后：usage 提取/日志/截断检测仍作用于上游
 * OpenAI 流（语义不变），本转换器只把 OpenAI chunk 转成 Anthropic 事件
 * （message_start → content_block_* → message_delta → message_stop）
 */
export function createAnthropicStreamTransformer(
  model: string,
  inputTokens: number
): TransformStream<Uint8Array, Uint8Array> {
  const streamer = new OpenAIToAnthropicStream({ model, inputTokens });
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let errored = false;
  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;
        if (!data) continue;
        try {
          const parsed = JSON.parse(data);
          // 流内 error：Anthropic 客户端靠 event: error 感知失败（三端语义一致）
          if (parsed.error) {
            const code = resolveStreamErrorStatus(parsed.error);
            if (code !== null) {
              errored = true;
              controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(formatAnthropicError(code, String(parsed.error.message || "").substring(0, 500)))}\n\n`));
              continue;
            }
          }
          // 纯 usage chunk（无 choices 键）也可能携带 output_tokens，不能过滤掉
          if (parsed.choices || parsed.usage) {
            const out = streamer.feedChunk(parsed);
            if (out) controller.enqueue(encoder.encode(out));
          }
        } catch {
          // 无法解析的行（非 JSON 数据）直接忽略，不影响流
        }
      }
    },
    flush(controller) {
      // 流内 error 已发事件，不再发正常收尾（message_stop）
      if (errored) return;
      const out = streamer.finish();
      if (out) controller.enqueue(encoder.encode(out));
    },
  });
}

/**
 * Anthropic SSE → OpenAI SSE 的 TransformStream（上游为 Anthropic 协议时专用）
 *
 * 接在 usage 提取之前：usage 提取/日志/截断检测作用于转换后的
 * OpenAI 流（语义不变），本转换器把 Anthropic 事件（message_start →
 * content_block_* → message_delta → message_stop）转成 OpenAI chunk，
 * 正常收尾输出 data: [DONE]（Anthropic 只有 message_stop，无 [DONE]）。
 */
export function createOpenAIStreamTransformer(): TransformStream<Uint8Array, Uint8Array> {
  const streamer = new AnthropicToOpenAIStream();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (!data) continue;
        try {
          const parsed = JSON.parse(data);
          const out = streamer.feedData(parsed);
          if (out) controller.enqueue(encoder.encode(out));
        } catch {
          // 无法解析的行（非 JSON 数据）直接忽略，不影响流
        }
      }
    },
    flush(controller) {
      const out = streamer.finish();
      if (out) controller.enqueue(encoder.encode(out));
    },
  });
}
