/**
 * Gemini GenerateContent API 类型定义
 *
 * 参考文档：https://ai.google.dev/api/generate-content
 *
 * 本文件仅声明 PR-B 最小骨架所需的类型子集：
 * - contents[] / parts[]（text、functionCall、functionResponse）
 * - tools[].functionDeclarations
 * - generationConfig（temperature/topP/topK/maxOutputTokens/stopSequences）
 * - systemInstruction
 * - usageMetadata（promptTokenCount/candidatesTokenCount/totalTokenCount）
 * - candidates[]（content / finishReason）
 *
 * 不在范围内（后续 PR 补全）：
 * - 多模态 inline_data / file_data（图像/音频/视频）
 * - thinking/thought part（Gemini 2.5+ 思考链）
 * - safetySettings / cachedContent / toolConfig.functionCallingConfig
 * - response_mime_type / response_schema（结构化输出）
 * - serviceTier / store
 */

/** Content 中的 role：user（人类输入）或 model（AI 输出/历史） */
export type GeminiRole = "user" | "model";

/** Part 的多态类型——本 PR 仅支持 text 与 functionCall/functionResponse 三个子类型 */
export interface GeminiTextPart {
  text: string;
}

export interface GeminiFunctionCallPart {
  functionCall: {
    name: string;
    args: Record<string, unknown>;
  };
}

export interface GeminiFunctionResponsePart {
  functionResponse: {
    name: string;
    response: Record<string, unknown>;
  };
}

export type GeminiPart = GeminiTextPart | GeminiFunctionCallPart | GeminiFunctionResponsePart;

/** Content = 一条消息（user 或 model） */
export interface GeminiContent {
  role: GeminiRole;
  parts: GeminiPart[];
}

/** systemInstruction 顶层字段，结构与 Content 一致但 role 限定 model */
export interface GeminiSystemInstruction {
  parts: GeminiPart[];
}

/** 单个 tool 的 function declaration */
export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

/** tools[] 元素：本 PR 仅支持 functionDeclarations */
export interface GeminiTool {
  functionDeclarations?: GeminiFunctionDeclaration[];
}

/** generationConfig 子集 */
export interface GeminiGenerationConfig {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
}

/** 完整 GenerateContent 请求体 */
export interface GeminiGenerateContentRequest {
  contents: GeminiContent[];
  tools?: GeminiTool[];
  systemInstruction?: GeminiSystemInstruction;
  generationConfig?: GeminiGenerationConfig;
}

/** candidates[] 元素：单次生成结果 */
export interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?:
    | "FINISH_REASON_UNSPECIFIED"
    | "STOP"
    | "MAX_TOKENS"
    | "SAFETY"
    | "RECITATION"
    | "OTHER";
  index?: number;
}

/** usageMetadata 子集（流式最后一片才有，非流式响应也有） */
export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

/** 完整 GenerateContent 响应体（非流式） */
export interface GeminiGenerateContentResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  modelVersion?: string;
  /** 提示被安全策略拦截的原因（顶层 block 标识） */
  promptFeedback?: {
    blockReason?: string;
  };
}
