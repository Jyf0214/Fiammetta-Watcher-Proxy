/**
 * Anthropic /v1/messages 请求 → OpenAI /chat/completions 请求转换
 *
 * 转换规则：
 * - system（字符串或 text 块数组）→ 首条 system 消息
 * - messages：string 或内容块数组；text 块拼接、image 块 → image_url part、
 *   tool_use 块 → assistant 消息的 tool_calls、tool_result 块 → 独立 tool 消息
 * - tools：input_schema → parameters（function 格式）
 * - tool_choice：auto/any/none/tool 映射到 OpenAI 形态
 * - stop_sequences → stop（OpenAI 最多 4 个，超长截断）
 * - top_k / metadata / thinking 等 OpenAI 无对应语义的字段剥离
 * - max_tokens 为 Anthropic 必填，缺失时返回错误
 */

import type { AnthropicMessagesRequest, AnthropicMessage, AnthropicContentBlock } from "./types";

/** 转换失败返回的校验错误（交由调用方以 Anthropic 错误格式响应） */
export class AnthropicRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnthropicRequestError";
  }
}

/** 把 system 字段（string | text 块数组）拼为纯文本 */
function systemToText(system: AnthropicMessagesRequest["system"]): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .filter((b) => b?.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n");
  }
  return "";
}

/** 转换产出的 OpenAI 消息（tool_calls / tool_call_id 仅在对应块存在时填充） */
interface OpenAIChatMessage {
  role: string;
  content: unknown;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/** 把 Anthropic 内容块数组转成 OpenAI 消息（可能拆出 tool 消息，可能无文本内容） */
function convertContentBlocks(
  role: "user" | "assistant",
  blocks: AnthropicContentBlock[]
): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = [];
  const textParts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [];

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        textParts.push({ type: "text", text: block.text });
        break;
      case "image": {
        const src = block.source;
        if (src?.type === "base64") {
          textParts.push({
            type: "image_url",
            image_url: { url: `data:${src.media_type};base64,${src.data}` },
          });
        } else if (src?.type === "url") {
          // Anthropic 允许 url 来源的图片，OpenAI 同样支持 image_url url 直传
          textParts.push({ type: "image_url", image_url: { url: src.url } });
        }
        break;
      }
      case "tool_use": {
        // 先落盘已累积的文本部分，再输出 tool_calls 消息
        if (textParts.length > 0) {
          out.push({ role, content: textParts.length === 1 && textParts[0].type === "text" ? textParts[0].text : textParts });
          textParts.length = 0;
        }
        out.push({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: block.id,
              type: "function",
              function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
            },
          ],
        });
        break;
      }
      case "tool_result": {
        // 工具结果必须紧跟 assistant tool_calls 消息（OpenAI 约束），
        // 因此不在此处落盘已累积的文本，交由循环末尾统一 flush
        const resultText = Array.isArray(block.content)
          ? block.content.map((b) => (b as { text?: string }).text ?? "").join("\n")
          : block.content ?? "";
        out.push({ role: "tool", tool_call_id: block.tool_use_id, content: resultText });
        break;
      }
      case "thinking":
        // OpenAI 无思考块语义，历史思考内容直接丢弃
        break;
    }
  }

  if (textParts.length > 0) {
    out.push({ role, content: textParts.length === 1 && textParts[0].type === "text" ? textParts[0].text : textParts });
  }
  return out;
}

/** 转换单条 Anthropic 消息 */
function convertMessage(message: AnthropicMessage): OpenAIChatMessage[] {
  const content = message.content;
  if (typeof content === "string") {
    return [{ role: message.role, content }];
  }
  if (!Array.isArray(content)) {
    // 病态输入（null / 对象 / 数字等）在转换层直接拒绝，避免 TypeError 落到 500
    throw new AnthropicRequestError("messages 内容块格式错误: content 必须为字符串或内容块数组");
  }
  return convertContentBlocks(message.role, content);
}

/** 转换 tool_choice（未知形态直接报错，避免静默吞掉后上游 400） */
function convertToolChoice(choice: NonNullable<AnthropicMessagesRequest["tool_choice"]>): unknown {
  switch (choice.type) {
    case "auto":
      return "auto";
    case "none":
      return "none";
    case "any":
      return "required";
    case "tool":
      if (!choice.name || typeof choice.name !== "string") {
        throw new AnthropicRequestError("tool_choice 为 tool 时必须提供 name");
      }
      return { type: "function", function: { name: choice.name } };
    default:
      throw new AnthropicRequestError(`不支持的 tool_choice 类型: ${String((choice as { type?: unknown }).type)}`);
  }
}

/**
 * Anthropic /v1/messages 请求体 → OpenAI /chat/completions 请求体
 *
 * @throws AnthropicRequestError 校验失败（缺 model / max_tokens 等）
 */
export function convertAnthropicRequest(body: Record<string, unknown>): Record<string, unknown> {
  const req = body as unknown as AnthropicMessagesRequest;

  if (!req.model || typeof req.model !== "string") {
    throw new AnthropicRequestError("缺少必填字段: model");
  }
  if (typeof req.max_tokens !== "number" || !Number.isFinite(req.max_tokens) || req.max_tokens < 1) {
    throw new AnthropicRequestError("缺少必填字段: max_tokens");
  }
  if (!Array.isArray(req.messages)) {
    throw new AnthropicRequestError("缺少必填字段: messages");
  }

  const openaiMessages: OpenAIChatMessage[] = [];

  const systemText = systemToText(req.system);
  if (systemText) {
    openaiMessages.push({ role: "system", content: systemText });
  }

  for (const message of req.messages) {
    if (!message || typeof message.role !== "string") continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    openaiMessages.push(...convertMessage(message));
  }

  const out: Record<string, unknown> = {
    model: req.model,
    messages: openaiMessages,
    max_tokens: req.max_tokens,
  };

  if (req.stream === true) out.stream = true;
  if (typeof req.temperature === "number") out.temperature = req.temperature;
  if (typeof req.top_p === "number") out.top_p = req.top_p;
  if (Array.isArray(req.stop_sequences) && req.stop_sequences.length > 0) {
    out.stop = req.stop_sequences.slice(0, 4);
  }
  if (Array.isArray(req.tools) && req.tools.length > 0) {
    out.tools = req.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        parameters: tool.input_schema ?? { type: "object" },
      },
    }));
  }
  if (req.tool_choice) {
    out.tool_choice = convertToolChoice(req.tool_choice);
  }

  return out;
}
