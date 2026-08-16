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
import { getNextKey } from "../platform-keys";
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
