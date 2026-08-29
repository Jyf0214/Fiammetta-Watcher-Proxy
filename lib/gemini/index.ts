/**
 * Gemini GenerateContent API 兼容转换层
 *
 * 统一出口：请求转换（OpenAI → Gemini）、响应转换（Gemini → OpenAI）、
 * SSE 流转换。
 *
 * PR-B 最小骨架范围：
 * - text + functionCall/functionResponse tool calling
 * - systemInstruction 顶层提取
 * - generationConfig 子集（temperature / topP / maxOutputTokens / stopSequences）
 * - 流式 ?alt=sse → OpenAI chat.completion.chunk
 *
 * 引用方式（与 detect-model-type / anthropic 相同的双路径模式）：
 * - worker/Pages 源码：import { ... } from "@/lib/gemini"
 * - 根 lib 内测试：import { ... } from "../gemini"
 */

export { convertOpenAIToGeminiRequest, GeminiRequestError } from "./upstream-request";
export {
  convertGeminiToOpenAIResponse,
  mapGeminiFinishReason,
  GeminiResponseError,
  type OpenAIChatResponse,
} from "./upstream-response";
export {
  convertGeminiStreamChunkToOpenAI,
  buildOpenAIUsageChunk,
  parseGeminiStreamLine,
  createGeminiStreamToOpenAITransformer,
  type OpenAIStreamChunk,
} from "./stream";
export type {
  GeminiGenerateContentRequest,
  GeminiGenerateContentResponse,
  GeminiContent,
  GeminiPart,
  GeminiRole,
  GeminiSystemInstruction,
  GeminiTool,
  GeminiFunctionDeclaration,
  GeminiGenerationConfig,
  GeminiCandidate,
  GeminiUsageMetadata,
} from "./types";
