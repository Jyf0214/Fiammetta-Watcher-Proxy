/**
 * OpenAI /chat/completions 请求 → Gemini :generateContent 请求转换
 *
 * 转换规则（PR-B 最小骨架）：
 * - messages: 提取首条 role=system 消息合并为 systemInstruction.parts（text），
 *   其余按 role 映射为 Gemini role（assistant → model），并把 OpenAI tool/tool_call
 *   消息拆为 model.functionCall / user.functionResponse 形式
 * - tools: 把 OpenAI tools[].function 拍平为 Gemini tools[].functionDeclarations
 * - temperature / top_p / top_k / max_tokens / stop 映射到 generationConfig 对应字段
 *
 * 严格白名单输出：Gemini 严格模式拒绝未知顶层字段（与 convertOpenAIRequest 同策略）
 *
 * 不在范围（后续 PR）：
 * - 多模态（image_url/audio）
 * - response_format / tool_choice / parallel_tool_calls / stream_options
 * - 思考链（reasoning_effort / reasoning_content）
 * - safetySettings / cachedContent
 */

import type {
  GeminiContent,
  GeminiFunctionDeclaration,
  GeminiGenerateContentRequest,
  GeminiPart,
  GeminiSystemInstruction,
  GeminiTool,
} from "./types";

/** 转换失败返回的校验错误（交由调用方以 OpenAI error 格式响应） */
export class GeminiRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiRequestError";
  }
}

/** OpenAI 风格 chat 消息的最小子集（仅本转换器关心的字段） */
interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null | Array<{ type: string; [k: string]: unknown }>;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface OpenAIToolFunction {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

interface OpenAITool {
  type: "function";
  function: OpenAIToolFunction;
}

interface OpenAIRequest {
  messages?: OpenAIChatMessage[];
  tools?: OpenAITool[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  // 已知非 Gemini 字段，转换时直接剥离
  stream?: boolean;
  stream_options?: unknown;
  n?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  logit_bias?: unknown;
  user?: string;
  response_format?: unknown;
  seed?: number;
  tools_choice?: unknown;
  parallel_tool_calls?: boolean;
  // reasoning_*（OpenAI o1 系列），Gemini 用 thinkingConfig（不在本 PR 范围）
  reasoning_effort?: unknown;
}

/** 把 OpenAI tool_calls 拆成 functionCall / functionResponse 两种 Part */
function convertToolCallsToParts(
  toolCalls: NonNullable<OpenAIChatMessage["tool_calls"]>
): GeminiPart[] {
  return toolCalls.map((tc) => {
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(tc.function.arguments);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // 解析失败时把原始字符串当文本回退——比丢弃信息更安全
      args = { _raw: tc.function.arguments };
    }
    return { functionCall: { name: tc.function.name, args } };
  });
}

/** 把 OpenAI tool 消息（带 tool_call_id）转 Gemini functionResponse Part */
function convertToolMessageToPart(msg: OpenAIChatMessage): GeminiPart | null {
  if (!msg.tool_call_id) {
    // 缺少 tool_call_id 视为无法映射（OpenAI 严格模式下也会 400）
    throw new GeminiRequestError("tool 消息缺少 tool_call_id");
  }
  let response: Record<string, unknown> = {};
  if (typeof msg.content === "string" && msg.content.length > 0) {
    try {
      const parsed = JSON.parse(msg.content);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        response = parsed as Record<string, unknown>;
      } else {
        response = { result: msg.content };
      }
    } catch {
      // 非 JSON 字符串时按 Gemini 文档推荐以 { result: ... } 包装
      response = { result: msg.content };
    }
  }
  return {
    functionResponse: {
      // name 必须与对应 functionCall.name 一致；OpenAI 上下文里没有 name
      // 字段，调用方需在 tool message 中通过自定义字段透传（PR-B 不做透传，
      // 兜底为 tool_call_id 字符串，避免 Gemini 400 "name is required"）
      name: msg.name ?? msg.tool_call_id,
      response,
    },
  };
}

/** 把消息数组转 Gemini contents[]（不含 system 消息） */
function convertMessagesToContents(
  messages: OpenAIChatMessage[]
): GeminiContent[] {
  const out: GeminiContent[] = [];
  // 相邻多条 model message（assistant）合并为单条 contents 元素（Gemini 不允许
  // 相邻同 role 出现？官方文档没有强制，但保持单条更清晰）
  for (const msg of messages) {
    if (msg.role === "system") continue; // systemInstruction 单独处理
    if (msg.role === "tool") {
      const part = convertToolMessageToPart(msg);
      if (part) {
        // tool 消息的角色在 Gemini 是 user（按 Gemini 文档：functionResponse 必须
        // 放在 user role 的 contents 元素中）
        const last = out[out.length - 1];
        if (last && last.role === "user") {
          last.parts.push(part);
        } else {
          out.push({ role: "user", parts: [part] });
        }
      }
      continue;
    }

    const role: "user" | "model" = msg.role === "assistant" ? "model" : "user";
    const parts: GeminiPart[] = [];
    // text content
    if (typeof msg.content === "string" && msg.content.length > 0) {
      parts.push({ text: msg.content });
    }
    // tool_calls（仅 model 角色持有）
    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      parts.push(...convertToolCallsToParts(msg.tool_calls));
    }
    if (parts.length === 0) {
      // 跳过空消息，避免 Gemini 400 "contents[N].parts is empty"
      continue;
    }
    out.push({ role, parts });
  }
  if (out.length === 0) {
    throw new GeminiRequestError("请求缺少有效消息（messages 为空或全部 system）");
  }
  return out;
}

/** 把首条 system 消息合并为 systemInstruction（仅 text） */
function extractSystemInstruction(
  messages: OpenAIChatMessage[]
): GeminiSystemInstruction | undefined {
  const systemTexts: string[] = [];
  for (const m of messages) {
    if (m.role !== "system") continue;
    if (typeof m.content === "string" && m.content.length > 0) {
      systemTexts.push(m.content);
    } else if (Array.isArray(m.content)) {
      // 多模态 system 块暂不展开
      for (const block of m.content) {
        if (block && block.type === "text" && typeof block.text === "string") {
          systemTexts.push(block.text);
        }
      }
    }
  }
  if (systemTexts.length === 0) return undefined;
  return {
    parts: systemTexts.map((t) => ({ text: t })),
  };
}

/** OpenAI tools[] → Gemini tools[].functionDeclarations */
function convertTools(tools: OpenAITool[] | undefined): GeminiTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  const declarations: GeminiFunctionDeclaration[] = [];
  for (const t of tools) {
    if (t.type !== "function") continue;
    declarations.push({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    });
  }
  if (declarations.length === 0) return undefined;
  return [{ functionDeclarations: declarations }];
}

/**
 * OpenAI 风格请求 → Gemini GenerateContent 请求。
 * 失败时抛 GeminiRequestError，由调用方以 OpenAI 错误格式响应 400。
 */
export function convertOpenAIToGeminiRequest(input: Record<string, unknown>): GeminiGenerateContentRequest {
  const req = input as OpenAIRequest;
  const messages = Array.isArray(req.messages) ? req.messages : [];
  const systemInstruction = extractSystemInstruction(messages);
  const contents = convertMessagesToContents(messages);
  const tools = convertTools(req.tools);

  const generationConfig: GeminiGenerateContentRequest["generationConfig"] = {};
  if (typeof req.temperature === "number") generationConfig.temperature = req.temperature;
  if (typeof req.top_p === "number") generationConfig.topP = req.top_p;
  if (typeof req.max_tokens === "number") generationConfig.maxOutputTokens = req.max_tokens;
  if (req.stop !== undefined) {
    generationConfig.stopSequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  }
  // OpenAI 无 top_k 字段（部分客户端通过 extra_headers 注入），跳过

  const out: GeminiGenerateContentRequest = { contents };
  if (systemInstruction) out.systemInstruction = systemInstruction;
  if (tools) out.tools = tools;
  if (Object.keys(generationConfig).length > 0) out.generationConfig = generationConfig;
  return out;
}
