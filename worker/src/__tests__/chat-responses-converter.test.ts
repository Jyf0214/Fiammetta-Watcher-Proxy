/**
 * Chat ↔ Responses 互转测试
 *
 * 覆盖：
 * - 请求体互转（chat → responses, responses → chat）
 * - 非流式响应互转（responses → chat, chat → responses）
 * - 工具转换（function 嵌套 ↔ 扁平）
 * - 推理透传（reasoning_effort / reasoning）
 * - 空完成防护与同模保持
 */

import { describe, it, expect } from "vitest";
import {
  convertChatToResponses,
  convertResponsesToChat,
  convertResponsesToChatResponse,
  convertChatToResponsesResponse,
  createResponsesToChatStream,
  createChatToResponsesStream,
} from "../chat-responses-converter";

describe("convertChatToResponses", () => {
  it("单条 user 消息 → responses input（input_text 包装）", () => {
    const chat = {
      model: "gpt-5",
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0.7,
    };
    const out = convertChatToResponses(chat, "gpt-5");
    expect(out.model).toBe("gpt-5");
    expect(out.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Hello" }] },
    ]);
    expect(out.temperature).toBe(0.7);
  });

  it("system 消息转为 instructions", () => {
    const chat = {
      model: "gpt-5",
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hi" },
      ],
    };
    const out = convertChatToResponses(chat, "gpt-5");
    expect(out.instructions).toBe("You are helpful");
    expect(out.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Hi" }] },
    ]);
  });

  it("多轮对话保留顺序", () => {
    const chat = {
      model: "gpt-5",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
        { role: "user", content: "How are you?" },
      ],
    };
    const out = convertChatToResponses(chat, "gpt-5");
    expect(out.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "input_text", text: "Hi there" }] },
      { role: "user", content: [{ type: "input_text", text: "How are you?" }] },
    ]);
  });

  it("数组内容 text → input_text, image_url → input_image", () => {
    const chat = {
      model: "gpt-5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Hello" },
            { type: "image_url", image_url: { url: "https://example.com/a.jpg" } },
          ],
        },
      ],
    };
    const out = convertChatToResponses(chat, "gpt-5");
    expect(out.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "Hello" },
          { type: "input_image", image_url: "https://example.com/a.jpg", detail: "auto" },
        ],
      },
    ]);
  });

  it("tool 角色转为 function_call_output", () => {
    const chat = {
      model: "gpt-5",
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } }] } as any,
        { role: "tool", tool_call_id: "call_1", content: '{"temp":20}' },
      ],
    };
    const out = convertChatToResponses(chat, "gpt-5");
    const input = out.input as any[];
    expect(input[2]).toMatchObject({
      type: "function_call_output",
      call_id: "call_1",
      output: '{"temp":20}',
    });
  });

  it("max_tokens → max_output_tokens", () => {
    const chat = { model: "gpt-5", messages: [{ role: "user", content: "Hi" }], max_tokens: 100 } as any;
    const out = convertChatToResponses(chat, "gpt-5");
    expect(out.max_output_tokens).toBe(100);
  });

  it("reasoning_effort → reasoning.effort", () => {
    const chat = { model: "gpt-5", messages: [{ role: "user", content: "Hi" }], reasoning_effort: "high" } as any;
    const out = convertChatToResponses(chat, "gpt-5");
    expect(out.reasoning).toEqual({ effort: "high" });
  });

  it("tools 嵌套 function → 扁平 name", () => {
    const chat = {
      model: "gpt-5",
      messages: [{ role: "user", content: "Hi" }],
      tools: [{ type: "function", function: { name: "get_weather", description: "Get weather", parameters: { type: "object" } } }],
      tool_choice: { type: "function", function: { name: "get_weather" } },
    } as any;
    const out = convertChatToResponses(chat, "gpt-5");
    expect((out.tools as any)[0]).toMatchObject({ type: "function", name: "get_weather" });
    expect((out.tools as any)[0].function).toBeUndefined();
    expect(out.tool_choice).toEqual({ type: "function", name: "get_weather" });
  });

  it("透传 Responses 特有字段", () => {
    const chat = {
      model: "gpt-5",
      messages: [{ role: "user", content: "Hi" }],
      truncation: "auto",
      store: true,
    } as any;
    const out = convertChatToResponses(chat, "gpt-5");
    expect(out.truncation).toBe("auto");
    expect(out.store).toBe(true);
  });
});

describe("convertResponsesToChat", () => {
  it("字符串 input → messages", () => {
    const resp = { model: "gpt-5", input: "Hello" };
    const out = convertResponsesToChat(resp, "gpt-5");
    expect(out.messages).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("数组 input 保留", () => {
    const resp = {
      model: "gpt-5",
      input: [{ role: "user", content: "Hi" }],
      instructions: "You are helpful",
    };
    const out = convertResponsesToChat(resp, "gpt-5");
    expect(out.messages).toEqual([
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Hi" },
    ]);
  });

  it("reasoning.effort → reasoning_effort", () => {
    const resp = { model: "gpt-5", input: "Hi", reasoning: { effort: "high", summary: "detailed" } };
    const out = convertResponsesToChat(resp, "gpt-5");
    expect((out as any).reasoning_effort).toBe("high");
  });

  it("tools 扁平 → 嵌套", () => {
    const resp = {
      model: "gpt-5",
      input: "Hi",
      tools: [{ type: "function", name: "get_weather", description: "Get weather", parameters: { type: "object" } }],
      tool_choice: { type: "function", name: "get_weather" },
    } as any;
    const out = convertResponsesToChat(resp, "gpt-5");
    expect((out.tools as any)[0]).toMatchObject({ type: "function", function: { name: "get_weather" } });
    expect((out as any).tool_choice).toEqual({ type: "function", function: { name: "get_weather" } });
  });
});

describe("convertResponsesToChatResponse", () => {
  it("output_text → choices[0].message.content", () => {
    const resp = {
      id: "resp_123",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello world" }] }],
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    };
    const out = convertResponsesToChatResponse(resp, "gpt-5");
    expect((out as any).choices[0].message.content).toBe("Hello world");
    expect((out as any).usage.prompt_tokens).toBe(10);
    expect((out as any).usage.completion_tokens).toBe(20);
  });

  it("reasoning summary → reasoning_content", () => {
    const resp = {
      id: "resp_123",
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "Thinking..." }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Answer" }] },
      ],
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    };
    const out = convertResponsesToChatResponse(resp, "gpt-5");
    expect((out as any).choices[0].message.reasoning_content).toBe("Thinking...");
    expect((out as any).choices[0].message.content).toBe("Answer");
  });

  it("空 output 时不触发空完成误判（返回空字符串但不抛错）", () => {
    const resp = { id: "resp_123", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } };
    const out = convertResponsesToChatResponse(resp, "gpt-5");
    expect((out as any).choices[0].message.content).toBe("");
  });

  it("output_text 顶层字段兜底", () => {
    const resp = { id: "resp_123", output_text: "Hello", usage: {} } as any;
    const out = convertResponsesToChatResponse(resp, "gpt-5");
    expect((out as any).choices[0].message.content).toBe("Hello");
  });
});

describe("convertChatToResponsesResponse", () => {
  it("choices content → output output_text", () => {
    const chat = {
      id: "chatcmpl-123",
      choices: [{ message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    };
    const out = convertChatToResponsesResponse(chat, "gpt-5");
    expect((out as any).output[0].content[0].text).toBe("Hello");
    expect((out as any).usage.input_tokens).toBe(10);
    expect((out as any).usage.output_tokens).toBe(20);
  });

  it("reasoning_content → reasoning summary", () => {
    const chat = {
      id: "chatcmpl-123",
      choices: [{ message: { role: "assistant", content: "Answer", reasoning_content: "Thinking..." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    };
    const out = convertChatToResponsesResponse(chat, "gpt-5");
    expect((out as any).output[0].type).toBe("reasoning");
    expect((out as any).output[0].summary[0].text).toBe("Thinking...");
  });
});

describe("streaming converters", () => {
  it("Responses → Chat 流：output_text.delta 转为 content", async () => {
    const transform = createResponsesToChatStream();
    const input = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}\n\n`;
    const readable = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(input));
        controller.close();
      },
    });
    const transformed = readable.pipeThrough(transform);
    const reader = transformed.getReader();
    const decoder = new TextDecoder();
    let result = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value);
    }
    expect(result).toContain("Hello");
    expect(result).toContain("choices");
    expect(result).toContain("[DONE]");
  });

  it("Chat → Responses 流：content 转为 output_text.delta", async () => {
    const transform = createChatToResponsesStream();
    const chatChunk = `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" }, index: 0, finish_reason: null }] })}\n\n`;
    const readable = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(chatChunk));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const transformed = readable.pipeThrough(transform);
    const reader = transformed.getReader();
    const decoder = new TextDecoder();
    let result = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value);
    }
    expect(result).toContain("output_text.delta");
    expect(result).toContain("Hello");
  });

  it("Responses 思考增量转为 reasoning_content", async () => {
    const transform = createResponsesToChatStream();
    const input = `data: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", delta: "Thinking..." })}\n\n`;
    const readable = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(input));
        controller.close();
      },
    });
    const transformed = readable.pipeThrough(transform);
    const reader = transformed.getReader();
    const decoder = new TextDecoder();
    let result = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value);
    }
    expect(result).toContain("reasoning_content");
    expect(result).toContain("Thinking...");
  });
});
