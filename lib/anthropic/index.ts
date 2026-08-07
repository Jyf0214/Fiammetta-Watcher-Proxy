/**
 * Anthropic Messages API 兼容转换层
 *
 * 统一出口：请求转换（Anthropic → OpenAI）、响应转换（OpenAI → Anthropic）、
 * SSE 流转换、token 估算、错误格式化。
 *
 * 引用方式（与 detect-model-type 相同的双路径模式）：
 * - worker/Pages 源码：import { ... } from "@/lib/anthropic"
 * - 根 lib 内测试：import { ... } from "../anthropic"
 */

export { convertAnthropicRequest, AnthropicRequestError } from "./request";
export { convertOpenAIResponse, mapFinishReason, generateAnthropicMessageId } from "./response";
export { OpenAIToAnthropicStream } from "./stream";
export { estimateInputTokens, estimateTextTokens, estimateMessageTokens } from "./count-tokens";
export { formatAnthropicError, toAnthropicErrorType } from "./errors";
export type {
  AnthropicMessagesRequest,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicTool,
  AnthropicToolChoice,
  AnthropicMessageResponse,
} from "./types";
