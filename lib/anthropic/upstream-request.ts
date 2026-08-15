/**
 * OpenAI /chat/completions 请求 → Anthropic /v1/messages 请求转换
 *
 * 用于"上游为 Anthropic 协议"的平台（官方 Anthropic / GitHub Copilot / Vercel AI 网关）：
 * 下游统一走 OpenAI 内部格式（含 /v1/messages 入口经 convertAnthropicRequest 转换后的结果），
 * 转发前再转回 Anthropic 请求体。
 *
 * 转换规则：
 * - system 消息 → 顶层 system 字段（多段拼接；兼容网关的顶层 system 字段优先）
 * - user/assistant 消息混合 text 与 image_url part → text/image 块
 * - assistant tool_calls → tool_use 块（arguments JSON 解析）
 * - tool 消息 → user 消息中的 tool_result 块（连续 tool 消息合并同一条 user 消息）
 * - tools（function 格式）→ input_schema；tool_choice 四种形态映射
 * - stop → stop_sequences；temperature/top_p/top_k 透传
 * - max_tokens 为 Anthropic 必填，OpenAI 缺失时默认 4096
 * - 白名单输出：Anthropic 严格模式拒绝未知字段（stream_options/n 等全部剥离）
 */

/** 转换失败返回的校验错误（交由调用方以对应协议错误格式响应） */
export class OpenAIRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAIRequestError";
  }
}

interface OpenAIRequest {
  model?: unknown;
  messages?: unknown;
  max_tokens?: unknown;
  max_completion_tokens?: unknown;
  stream?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  stop?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  [key: string]: unknown;
}

interface OpenAIMessage {
  role?: string;
  content?: string | Array<Record<string, unknown>> | null;
  tool_calls?: Array<{
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
  tool_call_id?: string;
}

type AnthropicBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source:
        | { type: "base64"; media_type: string; data: string }
        | { type: "url"; url: string };
    }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

/** 解析 OpenAI content（string | part 数组）为 Anthropic 块数组 */
function contentToBlocks(
  content: OpenAIMessage["content"]
): AnthropicBlock[] {
  const blocks: AnthropicBlock[] = [];
  if (typeof content === "string") {
    if (content) blocks.push({ type: "text", text: content });
    return blocks;
  }
  if (!Array.isArray(content)) return blocks;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    switch (part.type) {
      case "text":
        if (typeof part.text === "string" && part.text) {
          blocks.push({ type: "text", text: part.text });
        }
        break;
      case "image_url": {
        const url = (part.image_url as { url?: unknown } | undefined)?.url;
        if (typeof url !== "string" || !url) break;
        // data:image/{media_type};base64,{data} → base64 source；其余按 url source
        const m = /^data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(
          url
        );
        if (m) {
          blocks.push({
            type: "image",
            // data URI 正则捕获组不含 image/ 前缀，补回完整 MIME
            source: { type: "base64", media_type: `image/${m[1]}`, data: m[2] },
          });
        } else {
          blocks.push({ type: "image", source: { type: "url", url } });
        }
        break;
      }
      default:
        break;
    }
  }
  return blocks;
}

/** 解析 tool_choice（OpenAI 形态 → Anthropic 形态；未知形态剥离） */
function convertToolChoice(choice: unknown): unknown {
  if (choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  if (choice && typeof choice === "object") {
    const c = choice as { type?: unknown; function?: { name?: unknown } };
    if (c.type === "function" && typeof c.function?.name === "string") {
      return { type: "tool", name: c.function.name };
    }
  }
  return undefined;
}

/**
 * OpenAI /chat/completions 请求体 → Anthropic /v1/messages 请求体
 *
 * @throws OpenAIRequestError 校验失败（缺 model / messages 等）
 */
export function convertOpenAIRequest(
  body: Record<string, unknown>
): Record<string, unknown> {
  const req = body as OpenAIRequest;

  if (typeof req.model !== "string" || !req.model) {
    throw new OpenAIRequestError("缺少必填字段: model");
  }
  if (!Array.isArray(req.messages)) {
    throw new OpenAIRequestError("缺少必填字段: messages");
  }

  // system 消息 → 顶层 system（兼容网关的顶层 system 字段优先，消息内 system 追加）；
  // 其余消息按角色转换（合并连续同角色消息）
  const systemParts: string[] = [];
  if (typeof req.system === "string" && req.system) {
    systemParts.push(req.system);
  }
  const out: AnthropicMessage[] = [];

  for (const raw of req.messages) {
    const msg = raw as OpenAIMessage;
    if (!msg || typeof msg !== "object" || typeof msg.role !== "string") continue;

    if (msg.role === "system") {
      // system 内容可能是 string 或 part 数组，只取 text
      if (typeof msg.content === "string") {
        if (msg.content) systemParts.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part?.type === "text" && typeof part.text === "string" && part.text) {
            systemParts.push(part.text);
          }
        }
      }
      continue;
    }

    if (msg.role === "user") {
      const blocks = contentToBlocks(msg.content);
      if (blocks.length === 0) continue;
      const last = out[out.length - 1];
      if (last?.role === "user") {
        last.content.push(...blocks);
      } else {
        out.push({ role: "user", content: blocks });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const blocks: AnthropicBlock[] = [];
      const textBlocks = contentToBlocks(msg.content);
      blocks.push(...textBlocks);
      for (const tc of msg.tool_calls ?? []) {
        if (!tc || typeof tc !== "object") continue;
        let input: Record<string, unknown>;
        try {
          const parsed = JSON.parse(
            typeof tc.function?.arguments === "string" ? tc.function.arguments : "{}"
          ) as unknown;
          input =
            typeof parsed === "object" && parsed !== null
              ? (parsed as Record<string, unknown>)
              : {};
        } catch {
          input = {};
        }
        blocks.push({
          type: "tool_use",
          id: tc.id || `call_${blocks.length}`,
          name: typeof tc.function?.name === "string" ? tc.function.name : "unknown",
          input,
        });
      }
      // 空 assistant 消息（无文本无工具调用）丢弃，避免 Anthropic 交替规则校验失败
      if (blocks.length === 0) continue;
      const last = out[out.length - 1];
      if (last?.role === "assistant") {
        last.content.push(...blocks);
      } else {
        out.push({ role: "assistant", content: blocks });
      }
      continue;
    }

    if (msg.role === "tool") {
      const toolCallId =
        typeof msg.tool_call_id === "string" ? msg.tool_call_id : "";
      let resultText = "";
      if (typeof msg.content === "string") {
        resultText = msg.content;
      } else if (Array.isArray(msg.content)) {
        resultText = msg.content
          .filter((part) => part?.type === "text" && typeof part.text === "string")
          .map((part) => part.text as string)
          .join("\n");
      }
      const block: AnthropicBlock = {
        type: "tool_result",
        tool_use_id: toolCallId || `call_${out.length}`,
        content: resultText,
      };
      const last = out[out.length - 1];
      if (last?.role === "user") {
        last.content.push(block);
      } else {
        // 上游要求 tool_result 位于 user 消息；前面无 user 消息时新开一条
        out.push({ role: "user", content: [block] });
      }
      continue;
    }
  }

  // system 非空时拼入顶层字段（Anthropic system 支持 text 块数组）
  const system = systemParts.join("\n");

  const converted: Record<string, unknown> = {
    model: req.model,
    messages: out,
    max_tokens:
      typeof req.max_tokens === "number" && Number.isFinite(req.max_tokens)
        ? req.max_tokens
        : typeof req.max_completion_tokens === "number" &&
            Number.isFinite(req.max_completion_tokens)
          ? req.max_completion_tokens
          : 4096,
  };

  if (system) converted.system = system;
  if (req.stream === true) converted.stream = true;
  if (typeof req.temperature === "number") converted.temperature = req.temperature;
  if (typeof req.top_p === "number") converted.top_p = req.top_p;
  if (typeof req.top_k === "number" && Number.isInteger(req.top_k)) converted.top_k = req.top_k;
  if (typeof req.stop === "string") {
    converted.stop_sequences = [req.stop];
  } else if (Array.isArray(req.stop)) {
    const stops = req.stop.filter((s) => typeof s === "string");
    if (stops.length > 0) converted.stop_sequences = stops;
  }
  if (Array.isArray(req.tools) && req.tools.length > 0) {
    converted.tools = req.tools
      .filter(
        (t) =>
          t &&
          typeof t === "object" &&
          typeof (t as { type?: unknown }).type === "string" &&
          (t as { type: string }).type === "function"
      )
      .map((t) => {
        const fn = (t as { function?: Record<string, unknown> }).function ?? {};
        return {
          name: typeof fn.name === "string" ? fn.name : "unknown",
          ...(typeof fn.description === "string"
            ? { description: fn.description }
            : {}),
          input_schema:
            fn.parameters && typeof fn.parameters === "object"
              ? fn.parameters
              : { type: "object" },
        };
      });
  }
  const toolChoice = convertToolChoice(req.tool_choice);
  if (toolChoice !== undefined) converted.tool_choice = toolChoice;

  // 白名单输出：Anthropic 严格模式拒绝未知顶层字段
  return converted;
}