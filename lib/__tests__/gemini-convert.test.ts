/**
 * Gemini 转换层单测（PR-B 范围）
 *
 * 覆盖：
 * - convertOpenAIToGeminiRequest：典型消息/工具/系统提示
 * - convertGeminiToOpenAIResponse：文本/工具调用/finishReason 映射
 * - parseGeminiStreamLine + createGeminiStreamToOpenAITransformer：行解析与流转换
 * - 错误：空 messages、缺 tool_call_id、空 candidates
 *
 * 与 anthropic/ 同目录测试模式一致。
 */

import { describe, it, expect } from "vitest";
import {
  convertOpenAIToGeminiRequest,
  GeminiRequestError,
  convertGeminiToOpenAIResponse,
  GeminiResponseError,
  parseGeminiStreamLine,
  createGeminiStreamToOpenAITransformer,
} from "../gemini";

describe("convertOpenAIToGeminiRequest", () => {
  it("基本消息 + system 提取为 systemInstruction", () => {
    const out = convertOpenAIToGeminiRequest({
      messages: [
        { role: "system", content: "You are a cat." },
        { role: "user", content: "Hello" },
      ],
      temperature: 0.5,
      max_tokens: 100,
    });
    expect(out.systemInstruction?.parts).toEqual([{ text: "You are a cat." }]);
    expect(out.contents).toEqual([{ role: "user", parts: [{ text: "Hello" }] }]);
    expect(out.generationConfig?.temperature).toBe(0.5);
    expect(out.generationConfig?.maxOutputTokens).toBe(100);
  });

  it("多 system 消息合并", () => {
    const out = convertOpenAIToGeminiRequest({
      messages: [
        { role: "system", content: "First rule." },
        { role: "system", content: "Second rule." },
        { role: "user", content: "Hi" },
      ],
    });
    expect(out.systemInstruction?.parts).toEqual([
      { text: "First rule." },
      { text: "Second rule." },
    ]);
  });

  it("assistant 文本 → model role", () => {
    const out = convertOpenAIToGeminiRequest({
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello!" },
      ],
    });
    expect(out.contents[0].role).toBe("user");
    expect(out.contents[1].role).toBe("model");
    expect(out.contents[1].parts[0]).toEqual({ text: "Hello!" });
  });

  it("tool_calls → functionCall parts", () => {
    const out = convertOpenAIToGeminiRequest({
      messages: [
        { role: "user", content: "天气" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"北京"}' },
            },
          ],
        },
      ],
    });
    expect(out.contents[1].role).toBe("model");
    expect(out.contents[1].parts[0]).toEqual({
      functionCall: { name: "get_weather", args: { city: "北京" } },
    });
  });

  it("tool 消息 → user functionResponse", () => {
    const out = convertOpenAIToGeminiRequest({
      messages: [
        { role: "user", content: "查天" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: "{}" },
            },
          ],
        },
        { role: "tool", content: '{"temp":25}', tool_call_id: "call_1", name: "get_weather" },
      ],
    });
    // 期望：user role 的 contents 元素包含 functionResponse part
    const toolResponseContent = out.contents.find((c) =>
      c.parts.some((p) => "functionResponse" in p)
    );
    expect(toolResponseContent).toBeDefined();
    const fr = toolResponseContent!.parts.find((p) => "functionResponse" in p);
    expect(fr).toEqual({
      functionResponse: {
        name: "get_weather",
        response: { temp: 25 },
      },
    });
  });

  it("tools → functionDeclarations", () => {
    const out = convertOpenAIToGeminiRequest({
      messages: [{ role: "user", content: "Hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "获取天气",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        },
      ],
    });
    expect(out.tools?.[0].functionDeclarations?.[0]).toEqual({
      name: "get_weather",
      description: "获取天气",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    });
  });

  it("剥离 OpenAI 专属字段（stream/stream_options/n/response_format 等）", () => {
    const out = convertOpenAIToGeminiRequest({
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
      stream_options: { include_usage: true },
      n: 2,
      response_format: { type: "json_object" },
    } as unknown as Record<string, unknown>);
    // 输出不应包含这些字段
    const json = JSON.stringify(out);
    expect(json).not.toContain("stream_options");
    expect(json).not.toContain("response_format");
    expect(json).not.toContain('"n":2');
  });

  it("空 messages 报错", () => {
    expect(() => convertOpenAIToGeminiRequest({ messages: [] })).toThrow(GeminiRequestError);
  });

  it("空 system + 有 user 不报错", () => {
    const out = convertOpenAIToGeminiRequest({
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(out.systemInstruction).toBeUndefined();
  });

  it("messages 全部 system 报错", () => {
    expect(() =>
      convertOpenAIToGeminiRequest({
        messages: [
          { role: "system", content: "Only system." },
          { role: "system", content: "Another." },
        ],
      })
    ).toThrow(GeminiRequestError);
  });

  it("tool_call_id 缺失报错", () => {
    expect(() =>
      convertOpenAIToGeminiRequest({
        messages: [
          { role: "user", content: "Hi" },
          { role: "tool", content: "x" } as unknown as { role: "tool"; tool_call_id: string; content: string },
        ],
      })
    ).toThrow(GeminiRequestError);
  });

  it("stop 字符串/数组映射为 stopSequences", () => {
    const outStr = convertOpenAIToGeminiRequest({
      messages: [{ role: "user", content: "Hi" }],
      stop: "END",
    });
    expect(outStr.generationConfig?.stopSequences).toEqual(["END"]);
    const outArr = convertOpenAIToGeminiRequest({
      messages: [{ role: "user", content: "Hi" }],
      stop: ["END", "STOP"],
    });
    expect(outArr.generationConfig?.stopSequences).toEqual(["END", "STOP"]);
  });
});

describe("convertGeminiToOpenAIResponse", () => {
  it("text 文本 + STOP → OpenAI", () => {
    const out = convertGeminiToOpenAIResponse(
      {
        candidates: [
          {
            content: { role: "model", parts: [{ text: "Hello!" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
        modelVersion: "gemini-2.0-flash",
      },
      "gemini-2.0-flash"
    );
    expect(out.choices[0].message.content).toBe("Hello!");
    expect(out.choices[0].message.role).toBe("assistant");
    expect(out.choices[0].finish_reason).toBe("stop");
    expect(out.usage).toEqual({ prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
    expect(out.model).toBe("gemini-2.0-flash");
  });

  it("functionCall 映射为 tool_calls，finish_reason=tool_calls", () => {
    const out = convertGeminiToOpenAIResponse(
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ functionCall: { name: "get_weather", args: { city: "北京" } } }],
            },
            finishReason: "STOP",
          },
        ],
      },
      "gemini-2.0-flash"
    );
    expect(out.choices[0].message.content).toBeNull();
    expect(out.choices[0].message.tool_calls?.[0]).toEqual({
      id: "call_get_weather_0",
      type: "function",
      function: { name: "get_weather", arguments: '{"city":"北京"}' },
    });
    expect(out.choices[0].finish_reason).toBe("tool_calls");
  });

  it("MAX_TOKENS → length", () => {
    const out = convertGeminiToOpenAIResponse(
      { candidates: [{ content: { role: "model", parts: [{ text: "x" }] }, finishReason: "MAX_TOKENS" }] },
      "gemini-2.0-flash"
    );
    expect(out.choices[0].finish_reason).toBe("length");
  });

  it("SAFETY → content_filter", () => {
    const out = convertGeminiToOpenAIResponse(
      { candidates: [{ content: { role: "model", parts: [{ text: "x" }] }, finishReason: "SAFETY" }] },
      "gemini-2.0-flash"
    );
    expect(out.choices[0].finish_reason).toBe("content_filter");
  });

  it("空 candidates 报错", () => {
    expect(() => convertGeminiToOpenAIResponse({ candidates: [] }, "gemini-2.0-flash")).toThrow(
      GeminiResponseError
    );
  });

  it("promptFeedback.blockReason 报错", () => {
    expect(() =>
      convertGeminiToOpenAIResponse(
        { candidates: [{ content: { role: "model", parts: [{ text: "x" }] } }], promptFeedback: { blockReason: "SAFETY" } },
        "gemini-2.0-flash"
      )
    ).toThrow(GeminiResponseError);
  });
});

describe("parseGeminiStreamLine", () => {
  it("解析单行 data JSON", () => {
    const r = parseGeminiStreamLine(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: "Hi" }] }, finishReason: "STOP" }],
      }),
      "gemini-2.0-flash",
      "id1",
      1700000000
    );
    expect(r.error).toBeNull();
    expect(r.contentChunk?.choices[0].delta.content).toBe("Hi");
  });

  it("空 candidates + 有 usageMetadata → usageChunk", () => {
    const r = parseGeminiStreamLine(
      JSON.stringify({
        candidates: [],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
      }),
      "gemini-2.0-flash",
      "id1",
      1700000000
    );
    expect(r.contentChunk).toBeNull();
    expect(r.usageChunk?.usage).toEqual({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
  });

  it("JSON 解析失败 → error 字段", () => {
    const r = parseGeminiStreamLine("not json", "gemini-2.0-flash", "id1", 1700000000);
    expect(r.contentChunk).toBeNull();
    expect(r.usageChunk).toBeNull();
    expect(r.error).toBeTruthy();
  });

  it("promptFeedback.blockReason → error", () => {
    const r = parseGeminiStreamLine(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: "x" }] } }],
        promptFeedback: { blockReason: "SAFETY" },
      }),
      "gemini-2.0-flash",
      "id1",
      1700000000
    );
    expect(r.error).toContain("Gemini prompt blocked");
  });
});

describe("createGeminiStreamToOpenAITransformer", () => {
  // 简单 helper：构造一个把字符串数组按 SSE 格式写入的 ReadableStream
  function stringStream(lines: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(encoder.encode(line));
        }
        controller.close();
      },
    });
  }

  // helper：读取一个 ReadableStream 到字符串
  async function readAll(s: ReadableStream<Uint8Array>): Promise<string> {
    const reader = s.getReader();
    const decoder = new TextDecoder();
    let out = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
    return out;
  }

  it("转换单条 Gemini SSE 行为 OpenAI chunk + [DONE]", async () => {
    const geminiSse =
      `data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: "Hello" }] } }],
      })}\n\n` +
      `data: ${JSON.stringify({
        candidates: [],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
      })}\n\n`;
    const input = stringStream([geminiSse]);
    const output = input.pipeThrough(createGeminiStreamToOpenAITransformer("gemini-2.0-flash"));
    const out = await readAll(output);
    expect(out).toContain('"content":"Hello"');
    expect(out).toContain('"prompt_tokens":1');
    expect(out).toContain("data: [DONE]");
  });

  it("跨 chunk 边界的半行缓冲（拆字节）", async () => {
    const json = JSON.stringify({
      candidates: [{ content: { parts: [{ text: "Hi" }] } }],
    });
    // 故意把 "data: {JSON}\n\n" 拆成两半
    const half = `data: ${json}`.length;
    const full = `data: ${json}\n\n`;
    const input = stringStream([full.slice(0, half), full.slice(half)]);
    const output = input.pipeThrough(createGeminiStreamToOpenAITransformer("gemini-2.0-flash"));
    const out = await readAll(output);
    expect(out).toContain('"content":"Hi"');
    expect(out).toContain("data: [DONE]");
  });

  it("行 JSON 损坏 → 跳过该行（容错）", async () => {
    const geminiSse =
      `data: not json\n\n` +
      `data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: "OK" }] } }],
      })}\n\n`;
    const input = stringStream([geminiSse]);
    const output = input.pipeThrough(createGeminiStreamToOpenAITransformer("gemini-2.0-flash"));
    const out = await readAll(output);
    expect(out).toContain('"content":"OK"');
    expect(out).toContain("data: [DONE]");
  });
});
