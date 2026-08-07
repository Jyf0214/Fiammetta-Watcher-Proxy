/**
 * Token 计数估算（Anthropic /v1/messages/count_tokens 用）
 *
 * 中转站不持有 Anthropic 分词器，无法给出精确 token 数；
 * 用字符数/4 的业界通用近似（中文约 1 字 1 token，英文约 4 字符 1 token），
 * 另加每条消息与工具的固定开销，保证估算值稳定、可复现。
 */

import type { AnthropicMessagesRequest } from "./types";

/** 估算一段文本的 token 数 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** 估算消息的 token 数（消息结构开销 + 内容开销） */
export function estimateMessageTokens(message: NonNullable<AnthropicMessagesRequest["messages"]>[number]): number {
  let tokens = 4; // 消息结构开销
  const content = message?.content;
  if (typeof content === "string") {
    tokens += estimateTextTokens(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      switch (block.type) {
        case "text":
          tokens += estimateTextTokens(block.text);
          break;
        case "image":
          // 图片固定开销 + 内容开销（base64 按数据长度，url 按地址长度）
          tokens += 85 + estimateTextTokens(
            block.source?.type === "base64" ? block.source.data : block.source?.type === "url" ? block.source.url : ""
          );
          break;
        case "tool_use":
          tokens += 16 + estimateTextTokens(JSON.stringify(block.input ?? {}));
          break;
        case "tool_result":
          tokens += 8 + estimateTextTokens(
            typeof block.content === "string" ? block.content : ""
          );
          break;
        case "thinking":
          tokens += estimateTextTokens(block.thinking);
          break;
      }
    }
  }
  return tokens;
}

/** 估算完整 /v1/messages 请求的 input_tokens */
export function estimateInputTokens(body: Record<string, unknown>): number {
  const req = body as unknown as AnthropicMessagesRequest;
  let tokens = 0;

  if (req.system) {
    tokens += estimateTextTokens(
      typeof req.system === "string" ? req.system : req.system.map((b) => b.text).join("\n")
    );
  }
  if (Array.isArray(req.messages)) {
    for (const message of req.messages) {
      tokens += estimateMessageTokens(message);
    }
  }
  if (Array.isArray(req.tools)) {
    for (const tool of req.tools) {
      tokens += 16 + estimateTextTokens(JSON.stringify(tool));
    }
  }
  return Math.max(1, tokens);
}
