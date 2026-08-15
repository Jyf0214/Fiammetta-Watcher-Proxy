/**
 * Anthropic Messages API 兼容转换层单元测试
 *
 * 覆盖：请求转换（Anthropic → OpenAI）、响应转换（OpenAI → Anthropic）、
 * SSE 流转换（文本/工具/usage）、token 估算、错误格式化
 */

import { describe, it, expect } from "vitest";
import {
  convertAnthropicRequest,
  AnthropicRequestError,
  convertOpenAIResponse,
  OpenAIToAnthropicStream,
  estimateInputTokens,
  formatAnthropicError,
  toAnthropicErrorType,
  convertOpenAIRequest,
  convertAnthropicResponse,
  AnthropicToOpenAIStream,
  mapAnthropicErrorType,
} from "../anthropic";

// ==================== 请求转换 ====================

describe("convertAnthropicRequest", () => {
  it("基础请求：model/messages/max_tokens/stream", () => {
    const out = convertAnthropicRequest({
      model: "claude-sonnet-4",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(out.model).toBe("claude-sonnet-4");
    expect(out.stream).toBe(true);
    expect(out.max_tokens).toBe(1024);
    expect(out.messages).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("system 字符串 → 首条 system 消息", () => {
    const out = convertAnthropicRequest({
      model: "m",
      max_tokens: 10,
      system: "You are helpful",
      messages: [{ role: "user", content: "Hi" }],
    });
    const msgs = out.messages as Array<Record<string, unknown>>;
    expect(msgs[0]).toEqual({ role: "system", content: "You are helpful" });
    expect(msgs).toHaveLength(2);
  });

  it("system 块数组 → 拼接文本", () => {
    const out = convertAnthropicRequest({
      model: "m",
      max_tokens: 10,
      system: [{ type: "text", text: "A" }, { type: "text", text: "B" }],
      messages: [{ role: "user", content: "Hi" }],
    });
    const msgs = out.messages as Array<Record<string, unknown>>;
    expect(msgs[0]).toEqual({ role: "system", content: "A\nB" });
  });

  it("messages content 为块数组：text 合并、image → image_url", () => {
    const out = convertAnthropicRequest({
      model: "m",
      max_tokens: 10,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "看图" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          ],
        },
      ],
    });
    const msg = out.messages as Array<{ content: unknown }>;
    expect(msg[0].content).toEqual([
      { type: "text", text: "看图" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
  });

  it("tool_use 块 → assistant tool_calls，tool_result 块 → 独立 tool 消息", () => {
    const out = convertAnthropicRequest({
      model: "m",
      max_tokens: 10,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "我来查" },
            { type: "tool_use", id: "toolu_1", name: "get_weather", input: { location: "SF" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "晴" },
          ],
        },
      ],
    });
    const msgs = out.messages as Array<Record<string, unknown>>;
    expect(msgs[0]).toEqual({
      role: "assistant",
      content: "我来查",
    });
    expect(msgs[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "toolu_1", type: "function", function: { name: "get_weather", arguments: JSON.stringify({ location: "SF" }) } },
      ],
    });
    expect(msgs[2]).toEqual({ role: "tool", tool_call_id: "toolu_1", content: "晴" });
  });

  it("[text, tool_result] 混合块：tool 消息紧跟 assistant tool_calls，text 排最后", () => {
    const out = convertAnthropicRequest({
      model: "m",
      max_tokens: 10,
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { location: "SF" } }],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "查到了吗" },
            { type: "tool_result", tool_use_id: "toolu_1", content: "晴" },
          ],
        },
      ],
    });
    const msgs = out.messages as Array<Record<string, unknown>>;
    // tool 消息必须紧跟 assistant tool_calls（OpenAI 约束），text 不能插在中间
    expect(msgs.map((m) => m.role)).toEqual(["assistant", "tool", "user"]);
    expect(msgs[2]).toEqual({ role: "user", content: "查到了吗" });
  });

  it("content 为 null/对象等病态输入抛 AnthropicRequestError 而非 TypeError", () => {
    expect(() =>
      convertAnthropicRequest({
        model: "m",
        max_tokens: 10,
        messages: [{ role: "user", content: null } as never],
      })
    ).toThrow(AnthropicRequestError);
    expect(() =>
      convertAnthropicRequest({
        model: "m",
        max_tokens: 10,
        messages: [{ role: "user", content: { foo: "bar" } } as never],
      })
    ).toThrow(AnthropicRequestError);
  });

  it("image url 来源直映射 image_url", () => {
    const out = convertAnthropicRequest({
      model: "m",
      max_tokens: 10,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
          ],
        },
      ],
    });
    const msg = out.messages as Array<{ content: unknown }>;
    expect(msg[0].content).toEqual([
      { type: "image_url", image_url: { url: "https://example.com/a.png" } },
    ]);
  });

  it("tool_choice 未知类型抛 AnthropicRequestError", () => {
    expect(() =>
      convertAnthropicRequest({
        model: "m",
        max_tokens: 10,
        tool_choice: { type: "weird" } as never,
        messages: [{ role: "user", content: "x" }],
      })
    ).toThrow(AnthropicRequestError);
  });

  it("max_tokens 为 0 或 NaN 抛 AnthropicRequestError", () => {
    expect(() => convertAnthropicRequest({ model: "m", max_tokens: 0, messages: [] })).toThrow(AnthropicRequestError);
    expect(() => convertAnthropicRequest({ model: "m", max_tokens: Number.NaN, messages: [] })).toThrow(AnthropicRequestError);
  });

  it("thinking 块被剥离", () => {
    const out = convertAnthropicRequest({
      model: "m",
      max_tokens: 10,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "内部思考", signature: "sig" },
            { type: "text", text: "结论" },
          ],
        },
      ],
    });
    const msgs = out.messages as Array<Record<string, unknown>>;
    expect(msgs).toEqual([{ role: "assistant", content: "结论" }]);
  });

  it("tools：input_schema → parameters", () => {
    const out = convertAnthropicRequest({
      model: "m",
      max_tokens: 10,
      tools: [
        {
          name: "get_weather",
          description: "查天气",
          input_schema: { type: "object", properties: { location: { type: "string" } }, required: ["location"] },
        },
      ],
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(out.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "查天气",
          parameters: { type: "object", properties: { location: { type: "string" } }, required: ["location"] },
        },
      },
    ]);
  });

  it("tool_choice 映射：auto/any/none/tool", () => {
    const base = { model: "m", max_tokens: 10, messages: [{ role: "user", content: "x" }] };
    expect(convertAnthropicRequest({ ...base, tool_choice: { type: "auto" } }).tool_choice).toBe("auto");
    expect(convertAnthropicRequest({ ...base, tool_choice: { type: "any" } }).tool_choice).toBe("required");
    expect(convertAnthropicRequest({ ...base, tool_choice: { type: "none" } }).tool_choice).toBe("none");
    expect(convertAnthropicRequest({ ...base, tool_choice: { type: "tool", name: "f" } }).tool_choice)
      .toEqual({ type: "function", function: { name: "f" } });
  });

  it("stop_sequences → stop（最多 4 个）", () => {
    const out = convertAnthropicRequest({
      model: "m",
      max_tokens: 10,
      stop_sequences: ["a", "b", "c", "d", "e"],
      messages: [{ role: "user", content: "x" }],
    });
    expect(out.stop).toEqual(["a", "b", "c", "d"]);
  });

  it("top_k/metadata/thinking 等未知字段剥离", () => {
    const out = convertAnthropicRequest({
      model: "m",
      max_tokens: 10,
      top_k: 5,
      metadata: { user_id: "u1" },
      thinking: { type: "enabled", budget_tokens: 100 },
      messages: [{ role: "user", content: "x" }],
    });
    expect(out).not.toHaveProperty("top_k");
    expect(out).not.toHaveProperty("metadata");
    expect(out).not.toHaveProperty("thinking");
  });

  it("缺 model / max_tokens / messages 抛 AnthropicRequestError", () => {
    expect(() => convertAnthropicRequest({ max_tokens: 1, messages: [] })).toThrow(AnthropicRequestError);
    expect(() => convertAnthropicRequest({ model: "m", messages: [] })).toThrow(AnthropicRequestError);
    expect(() => convertAnthropicRequest({ model: "m", max_tokens: 1 })).toThrow(AnthropicRequestError);
  });
});

// ==================== 响应转换 ====================

describe("convertOpenAIResponse", () => {
  const openaiBase = {
    id: "chatcmpl-1",
    object: "chat.completion",
    model: "gpt-4o",
    choices: [{ index: 0, message: { role: "assistant", content: "Hi!" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };

  it("基础文本 + usage + model 回显", () => {
    const out = convertOpenAIResponse(openaiBase, "claude-sonnet-4");
    expect(out.type).toBe("message");
    expect(out.role).toBe("assistant");
    expect(out.model).toBe("claude-sonnet-4");
    expect(out.content).toEqual([{ type: "text", text: "Hi!" }]);
    expect(out.stop_reason).toBe("end_turn");
    expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(out.id).toMatch(/^msg_/);
  });

  it("content 为 part 数组时拼接文本", () => {
    const out = convertOpenAIResponse(
      {
        ...openaiBase,
        choices: [{ index: 0, message: { role: "assistant", content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] }, finish_reason: "stop" }],
      },
      "m"
    );
    expect(out.content).toEqual([{ type: "text", text: "AB" }]);
  });

  it("tool_calls → tool_use 块（arguments JSON 解析）", () => {
    const out = convertOpenAIResponse(
      {
        ...openaiBase,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"location":"SF"}' } }],
          },
          finish_reason: "tool_calls",
        }],
      },
      "m"
    );
    expect(out.content).toEqual([{ type: "tool_use", id: "call_1", name: "get_weather", input: { location: "SF" } }]);
    expect(out.stop_reason).toBe("tool_use");
  });

  it("arguments 解析为非对象（字符串）时回退空对象", () => {
    const out = convertOpenAIResponse(
      {
        ...openaiBase,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: '"plain-string"' } }],
          },
          finish_reason: "tool_calls",
        }],
      },
      "m"
    );
    expect(out.content).toEqual([{ type: "tool_use", id: "call_1", name: "f", input: {} }]);
  });

  it("content null 且无 tool_calls → 空 content 数组", () => {
    const out = convertOpenAIResponse(
      {
        ...openaiBase,
        choices: [{ index: 0, message: { role: "assistant", content: null }, finish_reason: "stop" }],
      },
      "m"
    );
    expect(out.content).toEqual([]);
  });

  it("finish_reason 映射：length → max_tokens", () => {
    const out = convertOpenAIResponse(
      { ...openaiBase, choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: "length" }] },
      "m"
    );
    expect(out.stop_reason).toBe("max_tokens");
  });
});

// ==================== 流式转换 ====================

describe("OpenAIToAnthropicStream", () => {
  it("纯文本流：message_start → text 块 → message_delta → message_stop", () => {
    const stream = new OpenAIToAnthropicStream({ model: "claude-sonnet-4", inputTokens: 25 });
    const out = feedAll(stream, [
      { choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "!" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { usage: { prompt_tokens: 9, completion_tokens: 15, total_tokens: 24 } },
    ]);

    expect(out).toContain('event: message_start');
    expect(out).toContain('"model":"claude-sonnet-4"');
    expect(out).toContain('"input_tokens":25');
    expect(out).toContain('event: content_block_start');
    expect(out).toContain('"content_block":{"type":"text","text":""}');
    expect(out).toContain('"delta":{"type":"text_delta","text":"Hello"}');
    expect(out).toContain('"delta":{"type":"text_delta","text":"!"}');
    expect(out).toContain('event: content_block_stop');
    expect(out).toContain('event: message_delta');
    expect(out).toContain('"stop_reason":"end_turn"');
    expect(out).toContain('"output_tokens":15');
    expect(out).toContain('event: message_stop');
    // 事件顺序：message_start 在最前，message_stop 在最后
    expect(out.indexOf('event: message_start')).toBeLessThan(out.indexOf('event: message_stop'));
    expect(out.indexOf('event: content_block_start')).toBeGreaterThan(out.indexOf('event: message_start'));
  });

  it("工具调用流：tool_use 块 + input_json_delta", () => {
    const stream = new OpenAIToAnthropicStream({ model: "m" });
    const out = feedAll(stream, [
      { choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
      {
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }] },
          finish_reason: null,
        }],
      },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"loc' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ation":"SF"}' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]);

    expect(out).toContain('"content_block":{"type":"tool_use","id":"call_1","name":"get_weather","input":{}}');
    // input_json_delta 为分段 JSON 增量，按实际输出片段断言
    expect(out).toContain('"partial_json":"{\\"loc"');
    expect(out).toContain('"partial_json":"ation\\":\\"SF\\"}"');
    expect(out).toContain('"stop_reason":"tool_use"');
  });

  it("文本块在工具块前关闭（文本后接工具调用）", () => {
    const stream = new OpenAIToAnthropicStream({ model: "m" });
    const out = feedAll(stream, [
      { choices: [{ index: 0, delta: { role: "assistant", content: "先想" }, finish_reason: null }] },
      {
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }] },
          finish_reason: null,
        }],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]);
    // 文本块 index 0 先 stop，工具块 index 1 后 stop
    const textStopIdx = out.indexOf('"index":0');
    const toolStopIdx = out.indexOf('"input_json_delta"');
    expect(textStopIdx).toBeGreaterThan(-1);
    expect(out.indexOf('"index":1')).toBeGreaterThan(-1);
    expect(toolStopIdx).toBeGreaterThan(textStopIdx);
  });

  it("无 usage 时 output_tokens 落 0", () => {
    const stream = new OpenAIToAnthropicStream({ model: "m" });
    const out = feedAll(stream, [
      { choices: [{ index: 0, delta: { role: "assistant", content: "x" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);
    expect(out).toContain('"output_tokens":0');
  });

  it("空输入（无任何 chunk）finish 返回空串", () => {
    const stream = new OpenAIToAnthropicStream({ model: "m" });
    expect(stream.finish()).toBe("");
  });

  it("finish() 幂等：重复调用返回空串，不重复输出收尾事件", () => {
    const stream = new OpenAIToAnthropicStream({ model: "m" });
    feedAll(stream, [
      { choices: [{ index: 0, delta: { role: "assistant", content: "x" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);
    const second = stream.finish();
    expect(second).toBe("");
  });
});

function feedAll(stream: OpenAIToAnthropicStream, chunks: Array<Record<string, unknown>>): string {
  let out = chunks.map((c) => stream.feedChunk(c)).join("");
  out += stream.finish();
  return out;
}

// ==================== token 估算 ====================

describe("estimateInputTokens", () => {
  it("基础估算：文本越长 token 越多", () => {
    const small = estimateInputTokens({ messages: [{ role: "user", content: "hi" }] });
    const large = estimateInputTokens({ messages: [{ role: "user", content: "x".repeat(400) }] });
    expect(large).toBeGreaterThan(small);
    expect(small).toBeGreaterThan(0);
  });

  it("system 与 tools 计入估算", () => {
    const withSystem = estimateInputTokens({
      system: "很长很长".repeat(50),
      messages: [{ role: "user", content: "hi" }],
    });
    const without = estimateInputTokens({ messages: [{ role: "user", content: "hi" }] });
    expect(withSystem).toBeGreaterThan(without);
  });
});

// ==================== 错误格式化 ====================

describe("formatAnthropicError", () => {
  it("状态码 → Anthropic 错误类型映射", () => {
    expect(formatAnthropicError(400, "bad").error.type).toBe("invalid_request_error");
    expect(formatAnthropicError(401, "unauthorized").error.type).toBe("authentication_error");
    expect(formatAnthropicError(429, "slow down").error.type).toBe("rate_limit_error");
    expect(formatAnthropicError(500, "boom").error.type).toBe("api_error");
    expect(formatAnthropicError(529, "overloaded").error.type).toBe("overloaded_error");
  });

  it("结构为 {type:'error', error:{type,message}}", () => {
    const err = formatAnthropicError(400, "缺少必填字段: max_tokens");
    expect(err.type).toBe("error");
    expect(err.error.message).toBe("缺少必填字段: max_tokens");
  });

  it("toAnthropicErrorType 默认分支保留 openai type", () => {
    expect(toAnthropicErrorType(418, "custom_error")).toBe("custom_error");
  });
});

// ==================== 上游转换：OpenAI 请求 → Anthropic 请求 ====================

describe("convertOpenAIRequest", () => {
  it("基础请求：model/messages/max_tokens/stream 同名透传", () => {
    const out = convertOpenAIRequest({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 1024,
      stream: true,
      temperature: 0.5,
      top_p: 0.9,
    });
    expect(out.model).toBe("claude-sonnet-4");
    expect(out.max_tokens).toBe(1024);
    expect(out.stream).toBe(true);
    expect(out.temperature).toBe(0.5);
    expect(out.top_p).toBe(0.9);
    expect(out.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Hello" }] }]);
  });

  it("system 消息 → 顶层 system 字段", () => {
    const out = convertOpenAIRequest({
      model: "m",
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hi" },
      ],
    });
    expect(out.system).toBe("You are helpful");
    expect(out.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Hi" }] }]);
  });

  it("顶层 system 字段优先于消息内 system，多段拼接", () => {
    const out = convertOpenAIRequest({
      model: "m",
      system: "模板 system",
      messages: [
        { role: "system", content: "消息 system" },
        { role: "user", content: "Hi" },
      ],
    });
    expect(out.system).toBe("模板 system\n消息 system");
  });

  it("top_k 透传（Anthropic 原生参数，模板配置生效）", () => {
    expect(convertOpenAIRequest({ model: "m", messages: [], top_k: 20 }).top_k).toBe(20);
  });

  it("max_tokens 缺失时默认 4096；max_completion_tokens 兜底", () => {
    expect(convertOpenAIRequest({ model: "m", messages: [] }).max_tokens).toBe(4096);
    expect(
      convertOpenAIRequest({ model: "m", messages: [], max_completion_tokens: 2048 }).max_tokens
    ).toBe(2048);
  });

  it("stop 字符串形态 → 单元素 stop_sequences；数组形态过滤非字符串", () => {
    expect(convertOpenAIRequest({ model: "m", messages: [], stop: "END" }).stop_sequences).toEqual([
      "END",
    ]);
    expect(
      convertOpenAIRequest({ model: "m", messages: [], stop: ["a", 1, "b"] }).stop_sequences
    ).toEqual(["a", "b"]);
    // 全非字符串数组不设置 stop_sequences
    expect(
      convertOpenAIRequest({ model: "m", messages: [], stop: [1, 2] }).stop_sequences
    ).toBeUndefined();
  });

  it("白名单剥离：stream_options/n/response_format 等未知字段不输出", () => {
    const out = convertOpenAIRequest({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      stream_options: { include_usage: true },
      n: 2,
      response_format: { type: "json_object" },
      user: "u1",
    });
    expect(out.stream_options).toBeUndefined();
    expect(out.n).toBeUndefined();
    expect(out.response_format).toBeUndefined();
    expect(out.user).toBeUndefined();
  });

  it("image_url data URI → base64 image 块，http url → url source", () => {
    const out = convertOpenAIRequest({
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "看图" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            { type: "image_url", image_url: { url: "https://example.com/a.png" } },
          ],
        },
      ],
    });
    const msg = out.messages as Array<{ content: unknown[] }>;
    expect(msg[0].content).toEqual([
      { type: "text", text: "看图" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
    ]);
  });

  it("assistant tool_calls → tool_use，tool 消息 → tool_result 且合并同一条 user 消息", () => {
    const out = convertOpenAIRequest({
      model: "m",
      messages: [
        { role: "user", content: "天气" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"sh\"}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "25 度" },
        { role: "tool", tool_call_id: "call_1", content: "补充数据" },
        { role: "user", content: "谢谢" },
      ],
    });
    const msgs = out.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(msgs).toHaveLength(3);
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].content[0]).toEqual({
      type: "tool_use",
      id: "call_1",
      name: "get_weather",
      input: { city: "sh" },
    });
    // 两条 tool 消息 + 后续 user 消息合并为一条 user（tool_result × 2 + text）
    expect(msgs[2].role).toBe("user");
    expect(msgs[2].content).toEqual([
      { type: "tool_result", tool_use_id: "call_1", content: "25 度" },
      { type: "tool_result", tool_use_id: "call_1", content: "补充数据" },
      { type: "text", text: "谢谢" },
    ]);
  });

  it("tool_choice 四种形态映射", () => {
    const auto = convertOpenAIRequest({ model: "m", messages: [], tool_choice: "auto" });
    expect(auto.tool_choice).toEqual({ type: "auto" });
    const none = convertOpenAIRequest({ model: "m", messages: [], tool_choice: "none" });
    expect(none.tool_choice).toEqual({ type: "none" });
    const required = convertOpenAIRequest({ model: "m", messages: [], tool_choice: "required" });
    expect(required.tool_choice).toEqual({ type: "any" });
    const tool = convertOpenAIRequest({
      model: "m",
      messages: [],
      tool_choice: { type: "function", function: { name: "get_weather" } },
    });
    expect(tool.tool_choice).toEqual({ type: "tool", name: "get_weather" });
  });

  it("tools function 格式 → input_schema", () => {
    const out = convertOpenAIRequest({
      model: "m",
      messages: [],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "查询天气",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        },
      ],
    });
    expect(out.tools).toEqual([
      {
        name: "get_weather",
        description: "查询天气",
        input_schema: { type: "object", properties: { city: { type: "string" } } },
      },
    ]);
  });

  it("缺少 model 抛 OpenAIRequestError", () => {
    expect(() => convertOpenAIRequest({ messages: [] })).toThrowError("缺少必填字段: model");
  });
});

// ==================== 上游转换：Anthropic 响应 → OpenAI 响应 ====================

describe("convertAnthropicResponse", () => {
  it("文本 + tool_use → content + tool_calls", () => {
    const out = convertAnthropicResponse(
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [
          { type: "text", text: "好的" },
          { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "sh" } },
          { type: "thinking", thinking: "思考过程" },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 50 },
      },
      "claude-sonnet-4"
    );
    expect(out.object).toBe("chat.completion");
    expect(out.model).toBe("claude-sonnet-4");
    expect(out.choices[0].message.content).toBe("好的");
    expect(out.choices[0].message.tool_calls).toEqual([
      {
        id: "toolu_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"sh"}' },
      },
    ]);
    expect(out.choices[0].finish_reason).toBe("tool_calls");
    // thinking 块丢弃
    expect(out.choices[0].message.content).not.toContain("思考过程");
  });

  it("usage 映射：input_tokens→prompt_tokens，output_tokens→completion_tokens", () => {
    const out = convertAnthropicResponse(
      {
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 20 },
      },
      "m"
    );
    expect(out.usage).toEqual({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
    expect(out.choices[0].finish_reason).toBe("stop");
  });

  it("stop_reason 映射：max_tokens→length", () => {
    const out = convertAnthropicResponse(
      { content: [], stop_reason: "max_tokens", usage: {} },
      "m"
    );
    expect(out.choices[0].finish_reason).toBe("length");
  });
});

// ==================== 上游转换：Anthropic SSE → OpenAI SSE ====================

describe("AnthropicToOpenAIStream", () => {
  it("完整文本流：role → content 增量 → finish → usage → [DONE]", () => {
    const s = new AnthropicToOpenAIStream();
    const out = [
      s.feedData({ type: "message_start", message: { usage: { input_tokens: 5 } } }),
      s.feedData({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      s.feedData({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } }),
      s.feedData({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "世界" } }),
      s.feedData({ type: "content_block_stop", index: 0 }),
      s.feedData({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }),
      s.feedData({ type: "message_stop" }),
    ].join("");

    const chunks = out.split("\n\n").filter(Boolean).map((c) => c.replace(/^data: /, ""));
    expect(JSON.parse(chunks[0])).toEqual({
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });
    expect(JSON.parse(chunks[1])).toEqual({
      choices: [{ index: 0, delta: { content: "你好" }, finish_reason: null }],
    });
    expect(JSON.parse(chunks[2])).toEqual({
      choices: [{ index: 0, delta: { content: "世界" }, finish_reason: null }],
    });
    expect(JSON.parse(chunks[3])).toEqual({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
    expect(JSON.parse(chunks[4]).usage).toEqual({
      prompt_tokens: 5,
      completion_tokens: 7,
      total_tokens: 12,
    });
    expect(chunks[5]).toBe("[DONE]");
  });

  it("工具流：首个 input_json_delta 携带 id/name，后续仅 arguments", () => {
    const s = new AnthropicToOpenAIStream();
    const out = [
      s.feedData({ type: "message_start" }),
      s.feedData({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "get_weather" } }),
      s.feedData({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"city\":" } }),
      s.feedData({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "\"sh\"}" } }),
      s.feedData({ type: "content_block_stop", index: 0 }),
      s.feedData({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
      s.feedData({ type: "message_stop" }),
    ].join("");

    const chunks = out.split("\n\n").filter(Boolean).map((c) => c.replace(/^data: /, ""));
    const first = JSON.parse(chunks[1]);
    expect(first.choices[0].delta.tool_calls[0]).toEqual({
      index: 0,
      id: "toolu_1",
      type: "function",
      function: { name: "get_weather", arguments: '{"city":' },
    });
    const second = JSON.parse(chunks[2]);
    expect(second.choices[0].delta.tool_calls[0]).toEqual({
      index: 0,
      function: { arguments: '"sh"}' },
    });
  });

  it("error 事件 → OpenAI 错误 chunk 且不输出 [DONE]", () => {
    const s = new AnthropicToOpenAIStream();
    const out =
      s.feedData({ type: "message_start" }) +
      s.feedData({ type: "error", error: { type: "overloaded_error", message: "过载" } }) +
      s.feedData({ type: "message_stop" }) +
      s.finish();
    const chunks = out.split("\n\n").filter(Boolean).map((c) => c.replace(/^data: /, ""));
    expect(chunks).toHaveLength(2);
    expect(JSON.parse(chunks[1]).error).toEqual({ code: 529, message: "过载" });
    expect(chunks.join()).not.toContain("[DONE]");
  });

  it("流截断（EOF 无 message_stop）：finish() 不输出 [DONE]", () => {
    const s = new AnthropicToOpenAIStream();
    s.feedData({ type: "message_start" });
    s.feedData({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "部分" } });
    expect(s.finish()).toBe("");
  });

  it("mapAnthropicErrorType 错误类型 → HTTP 码", () => {
    expect(mapAnthropicErrorType("overloaded_error")).toBe(529);
    expect(mapAnthropicErrorType("rate_limit_error")).toBe(429);
    expect(mapAnthropicErrorType("authentication_error")).toBe(401);
    expect(mapAnthropicErrorType("invalid_request_error")).toBe(400);
    expect(mapAnthropicErrorType("unknown_type")).toBe(500);
  });
});
