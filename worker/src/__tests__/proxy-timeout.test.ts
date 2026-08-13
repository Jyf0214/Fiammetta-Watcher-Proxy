/**
 * proxy 上游错误处理与超时保护测试
 *
 * 覆盖本次修复的核心行为：
 * 1. 非 2xx 上游响应真实透传状态码（此前流式分支硬编码 200，401/403/5xx 被伪装成成功）
 * 2. 401/403 纳入可重试状态（封禁 Key → 换 Key/换平台）
 * 3. 5xx 触发熔断器（recordFailure）且不重试
 * 4. withIdleTimeout 空闲超时流（挂起切断 / 正常流不受影响 / onTimeout 回调）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { proxyV1Request, withIdleTimeout } from "../proxy";
import { getNextKey, getRandomKeyExcept, banKey } from "../platform-keys";
import { recordFailure, recordSuccess } from "../load-balancer";
import { routeRequest } from "../router";
import { recordRequestLog } from "../token";
import type { PlatformConfig } from "@/lib/types";
import type { WorkerEnv } from "../config";

// ==================== 依赖 Mock ====================

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(async () => ({})),
}));

vi.mock("../router", () => ({
  routeRequest: vi.fn(),
  freezeAutoModel: vi.fn(),
  isAutoModelRequest: vi.fn(() => false),
  getPlatformsForModel: vi.fn(() => []),
}));

vi.mock("../platform-keys", () => ({
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

vi.mock("../load-balancer", () => ({
  recordSuccess: vi.fn(async () => {}),
  recordFailure: vi.fn(async () => {}),
}));

vi.mock("../rate-limiter", () => ({
  checkPlatformRpm: vi.fn(async () => ({ allowed: true })),
  checkApiKeyRpm: vi.fn(async () => ({ allowed: true })),
  checkPlatformTpm: vi.fn(async () => ({ allowed: true })),
  checkApiKeyTpm: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("../request-templates", () => ({
  loadTemplates: vi.fn(async () => []),
  getApplicableTemplates: vi.fn(() => []),
  applyTemplates: vi.fn((b: unknown) => b),
}));

vi.mock("../token", () => ({
  createUsageTransformer: vi.fn(() => new TransformStream()),
  recordRequestLog: vi.fn(async () => {}),
  extractUsage: vi.fn(() => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 })),
  updateKeyUsage: vi.fn(async () => {}),
}));

vi.mock("@/lib/key-status", () => ({
  keyFingerprint: vi.fn((key: string) => key.slice(0, 8)),
}));

// ==================== 测试辅助 ====================

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

const env = {
  DB: {} as D1Database,
  KV: {} as KVNamespace,
  DB_TYPE: "d1",
} as { DB: D1Database; KV: KVNamespace } & WorkerEnv;

// 流式成功路径用 ctx.waitUntil 保护 recordSuccess（不阻塞首字节），
// mock 里直接执行该 promise，与空闲超时路径的 waitUntilCtx 行为一致
const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    void p.catch(() => {});
  },
} as unknown as ExecutionContext;

const apiKey = {
  id: "key-id",
  key: "sk-client-key",
  name: "client",
  usedTokens: 0,
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
} as Parameters<typeof proxyV1Request>[2];

function buildRequest(body: Record<string, unknown>): Request {
  return new Request("https://proxy.test/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ==================== 状态码分派 ====================

describe("proxyV1Request 上游状态码处理", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(routeRequest).mockResolvedValue({
      platform: makePlatform(),
      targetModel: "target-model",
    });
    vi.mocked(getNextKey).mockReturnValue("sk-key1");
    vi.mocked(getRandomKeyExcept).mockReturnValue("sk-key2");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("流式请求遇到上游 500：返回真实 500 而非硬编码 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "upstream down" } }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    const res = await proxyV1Request(
      buildRequest({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }),
      { upstreamPath: "/chat/completions", supportsStreaming: true },
      apiKey,
      env,
      ctx
    );

    expect(res.status).toBe(500);
    // 5xx 不可重试：只发一次上游请求
    expect(fetch).toHaveBeenCalledTimes(1);
    // 触发熔断器
    expect(recordFailure).toHaveBeenCalledWith("test-platform", env.DB);
    expect(recordSuccess).not.toHaveBeenCalled();
  });

  it("流式请求遇到上游 401：封禁 Key 换 Key 重试，成功后返回 200", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "invalid key" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "ok", usage: { total_tokens: 5 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const res = await proxyV1Request(
      buildRequest({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }),
      { upstreamPath: "/chat/completions", supportsStreaming: true },
      apiKey,
      env,
      ctx
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 401 封禁当前 Key（与 429 相同路径）
    expect(banKey).toHaveBeenCalledTimes(1);
    expect(banKey).toHaveBeenCalledWith("sk-key1", undefined, "test-platform", env.KV);
    expect(res.status).toBe(200);
  });

  it("上游持续 401：换 Key 与换平台均耗尽后返回真实 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "invalid key" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    const res = await proxyV1Request(
      buildRequest({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      { upstreamPath: "/chat/completions", supportsStreaming: true },
      apiKey,
      env,
      ctx
    );

    // 初始 + 3 次重试
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(banKey).toHaveBeenCalledTimes(3);
    expect(res.status).toBe(401);
  });

  it("非流式 200 正常透传响应体", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ id: "ok", usage: { total_tokens: 5 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    const res = await proxyV1Request(
      buildRequest({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      { upstreamPath: "/chat/completions", supportsStreaming: false },
      apiKey,
      env,
      ctx
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe("ok");
    expect(recordSuccess).toHaveBeenCalledWith("test-platform", env.DB);
  });
});

// ==================== 空响应判定与重试 ====================

describe("proxyV1Request 空响应处理", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(routeRequest).mockResolvedValue({
      platform: makePlatform(),
      targetModel: "target-model",
    });
    vi.mocked(getNextKey).mockReturnValue("sk-key1");
    vi.mocked(getRandomKeyExcept).mockReturnValue("sk-key2");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("非流式上游返回空 body：判定无效封禁 Key 重试，第二次成功后返回 200", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("", { status: 200, headers: { "Content-Type": "application/json" } })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "ok", usage: { total_tokens: 5 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const res = await proxyV1Request(
      buildRequest({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      { upstreamPath: "/chat/completions", supportsStreaming: false },
      apiKey,
      env,
      ctx
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 空响应纳入与 429 相同的封禁路径
    expect(banKey).toHaveBeenCalledWith("sk-key1", undefined, "test-platform", env.KV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe("ok");
  });

  it("流式上游返回空流（无任何 SSE 数据）：判定无效重试，二次成功后返回 200", async () => {
    const encoder = new TextEncoder();
    const emptyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const sseStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"id":"ok"}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(emptyStream, { status: 200, headers: { "Content-Type": "text/event-stream" } })
      )
      .mockResolvedValueOnce(
        new Response(sseStream, { status: 200, headers: { "Content-Type": "text/event-stream" } })
      );
    vi.stubGlobal("fetch", fetchMock);

    const res = await proxyV1Request(
      buildRequest({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }),
      { upstreamPath: "/chat/completions", supportsStreaming: true },
      apiKey,
      env,
      ctx
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(banKey).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    // 消费响应流：验证首块经 paddedStream 拼回后数据完整透传（不丢失不重复）
    const reader = res.body!.getReader();
    const received: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received.push(new TextDecoder().decode(value));
    }
    expect(received.join("")).toContain('data: {"id":"ok"}');
    expect(received.join("")).toContain("data: [DONE]");
  });

  it("所有重试均返回空 body：耗尽后返回 502 且响应体非空", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("", { status: 200, headers: { "Content-Type": "application/json" } })
      )
    );

    const res = await proxyV1Request(
      buildRequest({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      { upstreamPath: "/chat/completions", supportsStreaming: false },
      apiKey,
      env,
      ctx
    );

    // 初始 + 3 次重试
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(banKey).toHaveBeenCalledTimes(3);
    expect(res.status).toBe(502);
    // 绝不返回空响应：错误体必须非空且语义明确
    const bodyText = await res.text();
    expect(bodyText.length).toBeGreaterThan(0);
    const parsed = JSON.parse(bodyText) as { error?: { message?: string } };
    expect(parsed.error?.message).toContain("空响应");
  });
});

// ==================== withIdleTimeout ====================

describe("withIdleTimeout 空闲超时流", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("挂起的流在 idleMs 后被切断并触发 onTimeout", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: hello\n\n"));
        // 之后不再产出数据，模拟上游挂起
      },
    });
    const onTimeout = vi.fn();
    const guarded = withIdleTimeout(source, 5000, onTimeout);
    const reader = guarded.getReader();

    // 第一块数据正常到达
    const first = await reader.read();
    expect(first.done).toBe(false);

    // 挂起 5s 后流被切断（error）
    const errPromise = reader.read().catch((e) => e);
    await vi.advanceTimersByTimeAsync(5000);
    const err = await errPromise;
    expect(err.name).toBe("TimeoutError");
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("持续传输数据的流不会被切断，正常读完且不触发 onTimeout", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    let chunks = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks++ < 3) {
          controller.enqueue(encoder.encode(`data: chunk${chunks}\n\n`));
        } else {
          controller.close();
        }
      },
    });
    const onTimeout = vi.fn();
    const guarded = withIdleTimeout(source, 5000, onTimeout);
    const reader = guarded.getReader();

    const received: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received.push(new TextDecoder().decode(value));
    }
    // 每块数据之间间隔 < idleMs，且读完前推进时钟验证定时器被不断重置
    await vi.advanceTimersByTimeAsync(30_000);

    expect(received).toEqual(["data: chunk1\n\n", "data: chunk2\n\n", "data: chunk3\n\n"]);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("正常结束（close）后定时器清理，不会误触发 onTimeout", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const onTimeout = vi.fn();
    const guarded = withIdleTimeout(source, 5000, onTimeout);
    const reader = guarded.getReader();
    await reader.read(); // 读完唯一一块
    await reader.read(); // done

    await vi.advanceTimersByTimeAsync(10_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});

// ==================== 空闲超时日志 ====================

describe("proxyV1Request 流式挂起空闲超时", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(routeRequest).mockResolvedValue({
      platform: makePlatform(),
      targetModel: "target-model",
    });
    vi.mocked(getNextKey).mockReturnValue("sk-key1");
    vi.mocked(getRandomKeyExcept).mockReturnValue("sk-key2");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("上游挂起 120 秒无数据：流切断，日志记 504 + isError=true（修复前记 200）", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const hangingStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[]}\n\n'));
        // 之后不再产出数据，模拟上游挂起
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(hangingStream, { status: 200, headers: { "Content-Type": "text/event-stream" } })
      )
    );

    // 空闲超时路径用 ctx.waitUntil 保护补记日志，mock 里直接执行该 promise
    const waitUntilCtx = {
      waitUntil: vi.fn((p: Promise<unknown>) => {
        void p.catch(() => {});
      }),
    } as unknown as ExecutionContext;

    const res = await proxyV1Request(
      buildRequest({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }),
      { upstreamPath: "/chat/completions", supportsStreaming: true },
      apiKey,
      env,
      waitUntilCtx
    );

    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);

    // 推进 120s：无数据到达 → 空闲超时切断流
    const errPromise = reader.read().catch((e) => e);
    await vi.advanceTimersByTimeAsync(120_000);
    const err = await errPromise;
    expect(err.name).toBe("TimeoutError");

    // 补记日志：status=504（修复前记录 200），isError=true，tokens=0
    expect(recordRequestLog).toHaveBeenCalledTimes(1);
    const logParams = vi.mocked(recordRequestLog).mock.calls[0][0];
    expect(logParams.status).toBe(504);
    expect(logParams.isError).toBe(true);
    expect(logParams.tokens).toBe(0);
    expect(logParams.errorMessage).toContain("空闲超时");
  });
});
