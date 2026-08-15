/**
 * 重现：Pages 版 v1 代理（pages/api/v1/[[...v1]].ts）
 * 上游返回 503，下游也收到 503，但日志记录 status 显示 200
 *
 * EdgeOne 生产部署没有 Worker，/v1/* 走 Pages API 版代理，
 * 此测试验证 Pages 版 5xx 透传分支的 recordRequestLog 收到的 status
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler from "../../../pages/api/v1/[[...v1]]";
import { validateApiKey } from "../../../worker/src/auth";
import { routeRequest } from "../../../worker/src/router";
import { getNextKey, getRandomKeyExcept } from "../../../worker/src/platform-keys";
import { getApplicableTemplates, applyTemplates } from "../../../worker/src/request-templates";
import { recordFailure } from "../../../worker/src/load-balancer";
import { recordRequestLog } from "../../../worker/src/token";
import type { PlatformConfig } from "@/lib/types";

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(async () => ({})),
}));

vi.mock("../../../worker/src/router", () => ({
  routeRequest: vi.fn(),
  refreshCache: vi.fn(),
  getPlatformCache: vi.fn(() => new Map()),
  getPlatformModelCache: vi.fn(() => new Map()),
  freezeAutoModel: vi.fn(),
  isAutoModelRequest: vi.fn(() => false),
  getPlatformsForModel: vi.fn(() => []),
}));

vi.mock("../../../worker/src/auth", () => ({
  validateApiKey: vi.fn(async () => ({ apiKey: { id: "key-id", key: "sk-client-key", name: "client" } })),
}));

vi.mock("../../../worker/src/platform-keys", () => ({
  getNextKey: vi.fn(() => "sk-key1"),
  getRandomKeyExcept: vi.fn(() => "sk-key2"),
  banKey: vi.fn(async () => {}),
  getAllKeys: vi.fn(() => ["sk-key1", "sk-key2"]),
  isKeyBanned: vi.fn(() => false),
  isKeyDeprioritized: vi.fn(() => false),
  isKeyWhitelisted: vi.fn(() => false),
  isKeyDisabled: vi.fn(() => false),
  recordKeyError: vi.fn(async () => {}),
  parseApiKeys: vi.fn(() => ["sk-key1", "sk-key2"]),
}));

vi.mock("../../../worker/src/load-balancer", () => ({
  recordSuccess: vi.fn(async () => {}),
  recordFailure: vi.fn(async () => {}),
}));

vi.mock("@/lib/v1-rate-limit", () => ({
  checkPlatformRpm: vi.fn(async () => ({ allowed: true })),
  checkApiKeyRpm: vi.fn(async () => ({ allowed: true })),
  checkPlatformTpm: vi.fn(async () => ({ allowed: true })),
  checkApiKeyTpm: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("../../../worker/src/request-templates", () => ({
  loadTemplates: vi.fn(async () => []),
  getApplicableTemplates: vi.fn(() => []),
  applyTemplates: vi.fn((b: unknown) => b),
}));

// Pages 版 v1 代理是内联实现，不调用 createUsageTransformer；
// recordRequestLog/updateKeyUsage 是 handler 直接调用处，extractUsage 用于内联 usage 提取
vi.mock("../../../worker/src/token", () => ({
  recordRequestLog: vi.fn(async () => {}),
  extractUsage: vi.fn(() => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 })),
  updateKeyUsage: vi.fn(async () => {}),
}));

vi.mock("../../../worker/src/forward-headers", () => ({
  extractForwardableHeaders: vi.fn(() => ({})),
  parseExtraHeaders: vi.fn(() => ({})),
}));

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB_TYPE: "d1" } })),
}));

function makePlatform(overrides: Partial<PlatformConfig> = {}): PlatformConfig {
  return {
    id: "test-platform",
    name: "Test",
    baseUrl: "https://api.test.com/v1",
    apiKeys: ["sk-key1", "sk-key2"],
    type: "openai",
    enabled: true,
    priority: 0,
    weight: 1,
    rpmLimit: null,
    tpmLimit: null,
    forwardHeaders: "",
    status: "healthy",
    failCount: 0,
    lastFailAt: null,
    cooldownEnd: null,
    ...overrides,
  };
}

/** 最小可迭代 NextApiRequest 模拟（parseRequestBody 用 for await 读 body） */
function makeReq(body: Record<string, unknown>): any {
  const text = JSON.stringify(body);
  const buf = Buffer.from(text);
  let offset = 0;
  return {
    headers: { "content-type": "application/json", "content-length": String(buf.length) },
    query: { v1: ["chat", "completions"] },
    method: "POST",
    [Symbol.asyncIterator]() {
      return {
        next: async (): Promise<IteratorResult<Buffer>> => {
          if (offset >= buf.length) return { done: true, value: undefined };
          const chunk = buf.subarray(offset, offset + 64);
          offset += chunk.length;
          return { done: false, value: chunk };
        },
      };
    },
  };
}

/** 最小 NextApiResponse 模拟，记录最终状态与 body */
function makeRes(): any {
  const calls: Array<{ type: string; status: number; body: unknown }> = [];
  let statusCode = 200;
  const res: any = {
    calls,
    status(c: number) {
      statusCode = c;
      return res;
    },
    json(b: unknown) {
      calls.push({ type: "json", status: statusCode, body: b });
      return res;
    },
    send(b: unknown) {
      calls.push({ type: "send", status: statusCode, body: b });
      return res;
    },
    write(_s: unknown) {
      return res;
    },
    end() {
      return res;
    },
    setHeader() {
      return res;
    },
    get statusCode() {
      return statusCode;
    },
  };
  return res;
}

describe("Pages 版 v1 代理 上游 503 日志重现", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(routeRequest).mockResolvedValue({
      platform: makePlatform(),
      targetModel: "target-model",
    });
    vi.mocked(validateApiKey).mockResolvedValue({
      apiKey: { id: "key-id", key: "sk-client-key", name: "client" } as any,
    });
    vi.mocked(getNextKey).mockReturnValue("sk-key1");
    vi.mocked(getRandomKeyExcept).mockReturnValue("sk-key2");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("非流式：上游 503 → 下游 503，日志 status 应为 503", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    const req = makeReq({ model: "m", messages: [{ role: "user", content: "hi" }] });
    const res = makeRes();
    await handler(req, res);

    expect(res.calls.length).toBe(1);
    expect(res.calls[0].status).toBe(503);
    expect(recordFailure).toHaveBeenCalledWith("test-platform", expect.anything());
    expect(recordRequestLog).toHaveBeenCalledTimes(1);
    const logParams = vi.mocked(recordRequestLog).mock.calls[0][0];
    expect(logParams.status).toBe(503);
  });

  it("流式：上游 503 → 下游 503，日志 status 应为 503", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    const req = makeReq({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] });
    const res = makeRes();
    await handler(req, res);

    expect(res.calls.length).toBe(1);
    expect(res.calls[0].status).toBe(503);
    expect(recordFailure).toHaveBeenCalledWith("test-platform", expect.anything());
    expect(recordRequestLog).toHaveBeenCalledTimes(1);
    const logParams = vi.mocked(recordRequestLog).mock.calls[0][0];
    expect(logParams.status).toBe(503);
  });

  it("修复验证：流式响应流内为 error 事件（无 token/usage）→ 日志记 error.code=503 + isError=true", async () => {
    const encoder = new TextEncoder();
    const errStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"error":{"message":"upstream down","code":503}}\n\n')
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(errStream, { status: 200, headers: { "Content-Type": "text/event-stream" } })
      )
    );

    const req = makeReq({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] });
    const res = makeRes();
    await handler(req, res);

    // 下游收到 200（响应头已发出，无法改状态）
    expect(res.calls.length).toBe(0); // 流式：无 json/send 调用，直接 write/end
    // 日志按流内 error.code 记录失败：503 + isError=true + tokens=0（修复前记录 200+isError=false）
    expect(recordRequestLog).toHaveBeenCalledTimes(1);
    const logParams = vi.mocked(recordRequestLog).mock.calls[0][0];
    expect(logParams.status).toBe(503);
    expect(logParams.isError).toBe(true);
    expect(logParams.tokens).toBe(0);
    expect(logParams.errorMessage).toBe("upstream down");
    expect(logParams.endpoint).toBe("/chat/completions");
  });

  it("修复验证：流式上游挂起（看门狗 120s 无数据）→ 日志记 504 + isError=true", async () => {
    // 看门狗用 Date.now() 轮询判超时，必须连同 Date 一起 fake 才能推进
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const encoder = new TextEncoder();
    const hangingStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[]}\n\n'));
        // 不再产出数据，模拟上游挂起
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(hangingStream, { status: 200, headers: { "Content-Type": "text/event-stream" } })
      )
    );

    const req = makeReq({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] });
    const res = makeRes();
    const p = handler(req, res);

    // 看门狗每 15s 轮询一次：小步推进并让微任务队列在每步间 flush，
    // 避免一次性大步推进时 handler 尚未创建看门狗
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }
    await p;

    // 补记日志：status=504（修复前记录 200），isError=true，tokens=0
    expect(recordRequestLog).toHaveBeenCalledTimes(1);
    const logParams = vi.mocked(recordRequestLog).mock.calls[0][0];
    expect(logParams.status).toBe(504);
    expect(logParams.isError).toBe(true);
    expect(logParams.tokens).toBe(0);
    expect(logParams.errorMessage).toContain("空闲超时");
  });
});

// ==================== 上游 Anthropic 协议 ====================

describe("Pages 版 v1 代理 上游 Anthropic 协议（模板先应用再转换）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(routeRequest).mockResolvedValue({
      platform: makePlatform({ type: "anthropic", baseUrl: "https://api.anthropic.com" }),
      targetModel: "claude-target",
    });
    vi.mocked(validateApiKey).mockResolvedValue({
      apiKey: { id: "key-id", key: "sk-client-key", name: "client" } as any,
    });
    vi.mocked(getNextKey).mockReturnValue("sk-key1");
    vi.mocked(getRandomKeyExcept).mockReturnValue("sk-key2");
    // 模板命中：注入 OpenAI 专属字段 + Anthropic 原生字段
    vi.mocked(getApplicableTemplates).mockReturnValue([
      { id: "t1", name: "t1", description: "", models: ["*"], mergeBody: {}, enabled: true },
    ]);
    vi.mocked(applyTemplates).mockImplementation((b) => ({
      ...(b as Record<string, unknown>),
      stream_options: { include_usage: true },
      n: 2,
      response_format: { type: "json_object" },
      top_k: 20,
      system: "模板 system",
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("模板先作用于原始请求再转换：OpenAI 专属字段剥离，Anthropic 原生字段透传", async () => {
    let sentUrl = "";
    let sentBody: Record<string, unknown> = {};
    const sentHeaders: Record<string, string> = {};
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      sentUrl = _url;
      sentBody = JSON.parse(String(init.body));
      const h = new Headers(init.headers as HeadersInit);
      h.forEach((v, k) => {
        sentHeaders[k] = v;
      });
      return new Response(
        JSON.stringify({
          id: "msg_1",
          content: [{ type: "text", text: "hi" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const req = makeReq({ model: "m", messages: [{ role: "user", content: "hi" }] });
    const res = makeRes();
    await handler(req, res);

    // URL 指向 /v1/messages
    expect(sentUrl).toBe("https://api.anthropic.com/v1/messages");
    // 模板在转换前应用：OpenAI 专属字段被转换白名单剥离
    expect(sentBody.stream_options).toBeUndefined();
    expect(sentBody.n).toBeUndefined();
    expect(sentBody.response_format).toBeUndefined();
    // Anthropic 原生字段透传
    expect(sentBody.top_k).toBe(20);
    expect(sentBody.system).toBe("模板 system");
    expect(sentBody.model).toBe("claude-target");
    // 认证头
    expect(sentHeaders["x-api-key"]).toBe("sk-key1");
    expect(sentHeaders["anthropic-version"]).toBe("2023-06-01");
  });
});
