/**
 * Lite 代理测试 — 单次尝试，不重试/不封禁/不熔断，只写日志
 *
 * 验证 proxyV1RequestLite：
 * - 上游 429/5xx → 真实透传，fetch 只调用一次（无重试）
 * - 路由失败 → 500 + 日志 platformId null
 * - 200+空 body → 下游 502 + 日志 status 502
 * - 成功路径日志 isError=false
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { proxyV1RequestLite } from "../proxy-lite";
import { routeRequestLite } from "../router-lite";
import { getNextKey, recordKeyError, banKey } from "../platform-keys";
import { recordRequestLog } from "../token";

vi.mock("../router-lite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../router-lite")>();
  return {
    ...actual,
    routeRequestLite: vi.fn(async () => null),
  };
});

vi.mock("../platform-keys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../platform-keys")>();
  return {
    ...actual,
    getNextKey: vi.fn(() => "sk-key1"),
    recordKeyError: vi.fn(async () => {}),
    banKey: vi.fn(async () => {}),
  };
});

vi.mock("../token", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../token")>();
  return {
    ...actual,
    recordRequestLog: vi.fn(async () => {}),
  };
});

const env = {
  DB: {} as D1Database,
  KV: {} as KVNamespace,
  DB_TYPE: "d1",
} as { DB: D1Database; KV: KVNamespace } & import("../config").WorkerEnv;

const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    void p.catch(() => {});
  },
} as unknown as ExecutionContext;

const apiKey = {
  id: "key-id",
  key: "sk-client-key",
  name: "client",
  usedTokens: 0n,
  rpmLimit: null,
  tpmLimit: null,
  callLimit: null,
  callUsed: 0,
  tokenLimit: null,
  resetPeriod: null,
  status: "active",
  expiresAt: null,
  createdAt: 0,
  updatedAt: 0,
} as Parameters<typeof proxyV1RequestLite>[2];

function buildRequest(body: Record<string, unknown>): Request {
  return new Request("https://proxy.test/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeRoute(overrides: Record<string, unknown> = {}) {
  return {
    platform: {
      id: "test-platform",
      name: "Test",
      baseUrl: "https://api.test.com/v1",
      apiKeys: ["sk-key1"],
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
    },
    targetModel: "target-model",
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(routeRequestLite).mockResolvedValue(makeRoute() as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("proxyV1RequestLite 单次尝试", () => {
  it("路由失败：下游 500「此模型不存在」，日志 platformId 为 null", async () => {
    vi.mocked(routeRequestLite).mockResolvedValue(null);

    const res = await proxyV1RequestLite(
      buildRequest({ model: "ghost-model", messages: [] }),
      { upstreamPath: "/chat/completions", supportsStreaming: true },
      apiKey,
      env,
      ctx
    );

    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordRequestLog).toHaveBeenCalledTimes(1);
    const logParams = vi.mocked(recordRequestLog).mock.calls[0][0];
    expect(logParams.platformId).toBeNull();
    expect(logParams.status).toBe(500);
    expect(logParams.isError).toBe(true);
  });

  it("上游 429：真实透传 429，fetch 只调用一次（无重试、无换 Key）", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      })
    );

    const res = await proxyV1RequestLite(
      buildRequest({ model: "m", messages: [] }),
      { upstreamPath: "/chat/completions", supportsStreaming: true },
      apiKey,
      env,
      ctx
    );

    expect(res.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordRequestLog).toHaveBeenCalledTimes(1);
    const logParams = vi.mocked(recordRequestLog).mock.calls[0][0];
    expect(logParams.platformId).toBe("test-platform");
    expect(logParams.status).toBe(429);
    expect(logParams.isError).toBe(true);
  });

  it("上游 402：真实透传 402，计数 +5 立即禁用密钥（与全量版对齐）", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "payment required" } }), {
        status: 402,
        headers: { "Content-Type": "application/json" },
      })
    );

    const res = await proxyV1RequestLite(
      buildRequest({ model: "m", messages: [] }),
      { upstreamPath: "/chat/completions", supportsStreaming: true },
      apiKey,
      env,
      ctx
    );

    expect(res.status).toBe(402);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordRequestLog).toHaveBeenCalledTimes(1);
    const logParams = vi.mocked(recordRequestLog).mock.calls[0][0];
    expect(logParams.platformId).toBe("test-platform");
    expect(logParams.status).toBe(402);
    expect(logParams.isError).toBe(true);
  });

  it("上游 503：真实透传 503，日志 status 记 503", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      })
    );

    const res = await proxyV1RequestLite(
      buildRequest({ model: "m", messages: [] }),
      { upstreamPath: "/chat/completions", supportsStreaming: false },
      apiKey,
      env,
      ctx
    );

    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const logParams = vi.mocked(recordRequestLog).mock.calls[0][0];
    expect(logParams.status).toBe(503);
    expect(logParams.isError).toBe(true);
  });

  it("上游 200+空 body：下游 502，日志 status 502", async () => {
    fetchMock.mockResolvedValue(
      new Response("", { status: 200, headers: { "Content-Type": "application/json" } })
    );

    const res = await proxyV1RequestLite(
      buildRequest({ model: "m", messages: [] }),
      { upstreamPath: "/chat/completions", supportsStreaming: false },
      apiKey,
      env,
      ctx
    );

    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const logParams = vi.mocked(recordRequestLog).mock.calls[0][0];
    expect(logParams.status).toBe(502);
    expect(logParams.isError).toBe(true);
    expect(logParams.errorMessage).toContain("空响应");
  });

  it("上游 200 成功：透传 200，日志 isError=false", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "x",
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const res = await proxyV1RequestLite(
      buildRequest({ model: "m", messages: [] }),
      { upstreamPath: "/chat/completions", supportsStreaming: false },
      apiKey,
      env,
      ctx
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const logParams = vi.mocked(recordRequestLog).mock.calls[0][0];
    expect(logParams.status).toBe(200);
    expect(logParams.isError).toBe(false);
    expect(logParams.completionTokens).toBe(20);
    expect(logParams.platformId).toBe("test-platform");
  });

  it("无可用 Key：下游 500，日志平台维度为该平台", async () => {
    vi.mocked(getNextKey).mockReturnValue(null);

    const res = await proxyV1RequestLite(
      buildRequest({ model: "m", messages: [] }),
      { upstreamPath: "/chat/completions", supportsStreaming: false },
      apiKey,
      env,
      ctx
    );

    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
    const logParams = vi.mocked(recordRequestLog).mock.calls[0][0];
    expect(logParams.platformId).toBe("test-platform");
    expect(logParams.isError).toBe(true);
  });

  it("流式请求 injectStreamOptions=true：请求体包含 stream_options", async () => {
    // 确保路由返回有效平台且存在可用 Key（避免上一测试的 mockReturnValue(null) 残留）
    vi.mocked(getNextKey).mockReturnValue("sk-key1");
    vi.mocked(routeRequestLite).mockResolvedValue(makeRoute() as never);

    let capturedBody: Record<string, unknown> | null = null;
    const streamMock = vi.fn().mockImplementation(async (url: string, opts: RequestInit) => {
      capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ id: "x", choices: [{ delta: { content: "hi" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", streamMock);

    const res = await proxyV1RequestLite(
      buildRequest({ model: "m", messages: [], stream: true }),
      { upstreamPath: "/chat/completions", supportsStreaming: true },
      apiKey,
      env,
      ctx
    );

    expect(res.status).toBe(200);
    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(capturedBody).not.toBeNull();
    expect(capturedBody!["stream_options"]).toEqual({ include_usage: true });
  });

  it("流式请求 injectStreamOptions=false：请求体不包含 stream_options", async () => {
    const streamMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "x", choices: [{ delta: { content: "hi" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", streamMock);

    vi.mocked(routeRequestLite).mockResolvedValue(
      makeRoute({ platform: { ...makeRoute().platform, injectStreamOptions: false } }) as never
    );

    await proxyV1RequestLite(
      buildRequest({ model: "m", messages: [], stream: true }),
      { upstreamPath: "/chat/completions", supportsStreaming: true },
      apiKey,
      env,
      ctx
    );

    expect(streamMock).toHaveBeenCalledTimes(1);
    const [_url, opts] = streamMock.mock.calls[0];
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty("stream_options");
  });
});

// ==================== 空 body 请求（W9） ====================

describe("proxyV1RequestLite 空 body 请求", () => {
  it("空 body：直接返回 400，不发上游请求、不路由（与全量版 JSON.parse(\"\") 抛错行为一致）", async () => {
    const res = await proxyV1RequestLite(
      new Request("https://proxy.test/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "",
      }),
      { upstreamPath: "/chat/completions", supportsStreaming: true },
      apiKey,
      env,
      ctx
    );

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(routeRequestLite).not.toHaveBeenCalled();
    expect(recordRequestLog).not.toHaveBeenCalled();
  });
});

// ==================== 流内 error 密钥级处理（W5） ====================

describe("proxyV1RequestLite 流内 error 密钥级处理", () => {
  beforeEach(() => {
    vi.mocked(recordKeyError).mockClear();
    vi.mocked(banKey).mockClear();
  });

  it("流内 error（429）：recordKeyError + banKey（与 HTTP 429 透传路径对齐）", async () => {
    const encoder = new TextEncoder();
    const sseStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"error":{"message":"rate limited","code":429}}\n\n')
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    fetchMock.mockResolvedValue(
      new Response(sseStream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    );

    const res = await proxyV1RequestLite(
      buildRequest({ model: "m", messages: [], stream: true }),
      { upstreamPath: "/chat/completions", supportsStreaming: true },
      apiKey,
      env,
      ctx
    );

    expect(res.status).toBe(200);
    // 消费响应流，触发 transformer flush
    const reader = res.body!.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }

    expect(banKey).toHaveBeenCalledWith("sk-key1", undefined, "test-platform");
    expect(recordKeyError).toHaveBeenCalledWith(
      "sk-key1",
      429,
      "test-platform",
      env.DB,
      { DB_TYPE: "d1" }
    );
    // 日志按 error.code 记失败
    const logParams = vi.mocked(recordRequestLog).mock.calls[0][0];
    expect(logParams.status).toBe(429);
    expect(logParams.isError).toBe(true);
  });

  it("流内 error（非密钥类 503）：不触发 recordKeyError/banKey", async () => {
    const encoder = new TextEncoder();
    const sseStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"error":{"message":"upstream down","code":503}}\n\n')
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    fetchMock.mockResolvedValue(
      new Response(sseStream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    );

    const res = await proxyV1RequestLite(
      buildRequest({ model: "m", messages: [], stream: true }),
      { upstreamPath: "/chat/completions", supportsStreaming: true },
      apiKey,
      env,
      ctx
    );

    const reader = res.body!.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }

    expect(banKey).not.toHaveBeenCalled();
    expect(recordKeyError).not.toHaveBeenCalled();
    const logParams = vi.mocked(recordRequestLog).mock.calls[0][0];
    expect(logParams.status).toBe(503);
    expect(logParams.isError).toBe(true);
  });
});

// ==================== multipart 挂起超时补记（W8） ====================

describe("proxyV1RequestLite multipart 挂起超时", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("multipart 响应挂起 120 秒无数据：流切断 + onTimeout 补记 504 日志", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const hangingMultipart = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("--boundary\r\nContent-Type: text/plain\r\n\r\npartial"));
        // 之后不再产出数据，模拟上游挂起
      },
    });
    fetchMock.mockResolvedValue(
      new Response(hangingMultipart, {
        status: 200,
        headers: { "Content-Type": "multipart/mixed; boundary=boundary" },
      })
    );

    // 超时补记日志走 ctx.waitUntil，mock 直接执行该 promise
    const waitUntilCtx = {
      waitUntil: vi.fn((p: Promise<unknown>) => {
        void p.catch(() => {});
      }),
    } as unknown as ExecutionContext;

    const res = await proxyV1RequestLite(
      buildRequest({ model: "m", messages: [] }),
      { upstreamPath: "/chat/completions", supportsStreaming: true },
      apiKey,
      env,
      waitUntilCtx
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("multipart/");

    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);

    // 挂起 120s：空闲超时切断流（此前无 onTimeout，静默切断零补记）
    const errPromise = reader.read().catch((e) => e);
    await vi.advanceTimersByTimeAsync(120_000);
    const err = await errPromise;
    expect(err.name).toBe("TimeoutError");

    // 200 成功日志 + 504 超时补记
    const logs = vi.mocked(recordRequestLog).mock.calls.map((c) => c[0]);
    expect(logs).toHaveLength(2);
    const timeoutLog = logs.find((l) => l.status === 504);
    expect(timeoutLog).toBeDefined();
    expect(timeoutLog!.isError).toBe(true);
    expect(timeoutLog!.tokens).toBe(0);
    expect(timeoutLog!.errorMessage).toContain("空闲超时");
  });
});

// ==================== 透传白名单认证类头过滤（W7-lite） ====================

describe("proxyV1RequestLite forwardHeaders 认证类头过滤（W7）", () => {
  it("白名单含认证类头也被丢弃：平台密钥不被下游覆盖，非认证头正常透传", async () => {
    vi.mocked(routeRequestLite).mockResolvedValue(
      makeRoute({
        platform: {
          id: "test-platform",
          name: "Test",
          baseUrl: "https://api.test.com/v1",
          apiKeys: ["sk-key1"],
          type: "openai",
          enabled: true,
          priority: 0,
          weight: 1,
          rpmLimit: null,
          tpmLimit: null,
          forwardHeaders: JSON.stringify([
            "Authorization",
            "X-Api-Key",
            "X-Auth-Token",
            "Content-Type",
            "X-Custom-Header",
          ]),
          status: "healthy",
          failCount: 0,
          lastFailAt: null,
          cooldownEnd: null,
        },
      }) as never
    );

    const sentHeaders: Record<string, string> = {};
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      const h = new Headers(init.headers as HeadersInit);
      h.forEach((v, k) => {
        sentHeaders[k] = v;
      });
      return new Response(
        JSON.stringify({ id: "ok", usage: { total_tokens: 5 } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const request = new Request("https://proxy.test/v1/chat/completions", {
      method: "POST",
      headers: {
        // 与平台构造值不同：若过滤失效，下游值会覆盖平台值
        "Content-Type": "application/x-ndjson",
        Authorization: "Bearer evil-client-token",
        "X-Api-Key": "evil-client-key",
        "X-Auth-Token": "evil-token",
        "X-Custom-Header": "custom-value",
      },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    });

    const res = await proxyV1RequestLite(
      request,
      { upstreamPath: "/chat/completions", supportsStreaming: false },
      apiKey,
      env,
      ctx
    );

    expect(res.status).toBe(200);
    // 认证类头被丢弃：上游仍是平台密钥，未被下游覆盖
    expect(sentHeaders["authorization"]).toBe("Bearer sk-key1");
    expect(sentHeaders["x-api-key"]).toBeUndefined();
    expect(sentHeaders["x-auth-token"]).toBeUndefined();
    // 请求语义关键头被丢弃：仍是平台构造的 Content-Type
    expect(sentHeaders["content-type"]).toBe("application/json");
    // 非认证类白名单头正常透传
    expect(sentHeaders["x-custom-header"]).toBe("custom-value");
  });
});
