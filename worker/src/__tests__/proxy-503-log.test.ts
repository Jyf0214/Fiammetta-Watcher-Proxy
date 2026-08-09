/**
 * 重现：上游返回 503，下游也收到 503，但日志记录 status 显示 200
 *
 * 验证 5xx 透传分支的 recordRequestLog 收到的 status 是否为上游真实状态码
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { proxyV1Request } from "../proxy";
import { getNextKey, getRandomKeyExcept } from "../platform-keys";
import { recordFailure } from "../load-balancer";
import { routeRequest } from "../router";
import { recordRequestLog } from "../token";
import type { PlatformConfig } from "@/lib/types";
import type { WorkerEnv } from "../config";

// 流内 error 端到端测试需要真实 createUsageTransformer：其 flush 通过
// createDb 直接写 DB，因此用 spy prisma 捕获日志参数（recordRequestLog mock
// 只覆盖 proxy.ts 直接调用处：5xx 透传、空响应、空闲超时）
const { prismaSpy } = vi.hoisted(() => ({
  prismaSpy: {
    apiKeys: { update: vi.fn(async () => ({})) },
    requestLogs: { create: vi.fn(async (_args: { data: any }) => ({})) },
  },
}));

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(async () => prismaSpy),
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

vi.mock("../token", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../token")>();
  return {
    ...actual,
    // 流式成功路径的日志由真实 createUsageTransformer flush 写入（走 prismaSpy），
    // 这里只 mock proxy.ts 直接调用的 recordRequestLog/updateKeyUsage
    recordRequestLog: vi.fn(async () => {}),
    updateKeyUsage: vi.fn(async () => {}),
  };
});

vi.mock("@/lib/key-status", () => ({
  keyFingerprint: vi.fn((key: string) => key.slice(0, 8)),
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

const env = {
  DB: {} as D1Database,
  KV: {} as KVNamespace,
  DB_TYPE: "d1",
} as { DB: D1Database; KV: KVNamespace } & WorkerEnv;

// 流式成功路径用 ctx.waitUntil 保护 recordSuccess（不阻塞首字节），
// mock 里直接执行该 promise
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

describe("上游 503 时日志记录状态码重现", () => {
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

  it("非流式请求：上游 503 → 下游 503，日志 status 应为 503", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), {
          status: 503,
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

    expect(res.status).toBe(503);
    expect(recordFailure).toHaveBeenCalledWith("test-platform", env.DB);
    expect(recordRequestLog).toHaveBeenCalledTimes(1);
    const logParams = vi.mocked(recordRequestLog).mock.calls[0][0];
    console.log("[repro] 非流式 503 日志参数:", JSON.stringify({
      status: logParams.status,
      isError: logParams.isError,
      errorMessage: logParams.errorMessage,
    }));
    expect(logParams.status).toBe(503);
  });

  it("流式请求：上游 503 → 下游 503，日志 status 应为 503", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), {
          status: 503,
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

    expect(res.status).toBe(503);
    expect(recordFailure).toHaveBeenCalledWith("test-platform", env.DB);
    expect(recordRequestLog).toHaveBeenCalledTimes(1);
    const logParams = vi.mocked(recordRequestLog).mock.calls[0][0];
    console.log("[repro] 流式 503 日志参数:", JSON.stringify({
      status: logParams.status,
      isError: logParams.isError,
      errorMessage: logParams.errorMessage,
    }));
    expect(logParams.status).toBe(503);
  });

  it("修复验证：上游 200+空 body 重试耗尽 → 下游 502，日志 status 也记 502", async () => {
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

    // 下游收到 502
    expect(res.status).toBe(502);
    // 日志 status 与实际下发一致：502（修复前记录上游的 200）
    expect(recordRequestLog).toHaveBeenCalledTimes(1);
    const logParams = vi.mocked(recordRequestLog).mock.calls[0][0];
    console.log("[repro] 空响应耗尽日志参数:", JSON.stringify({
      status: logParams.status,
      isError: logParams.isError,
      errorMessage: logParams.errorMessage,
      tokens: logParams.tokens,
    }));
    expect(logParams.status).toBe(502);
    expect(logParams.isError).toBe(true);
    expect(logParams.errorMessage).toContain("空响应");
  });

  it("修复验证：上游 200+SSE 流内为 error 事件（无 token）→ flush 日志记 error.code=503+isError=true", async () => {
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

    const res = await proxyV1Request(
      buildRequest({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }),
      { upstreamPath: "/chat/completions", supportsStreaming: true },
      apiKey,
      env,
      ctx
    );

    // 下游收到 200（响应头已发出，无法改状态）
    expect(res.status).toBe(200);
    // 消费响应体触发 transformer flush（流惰性执行，不消费则 flush 不运行）
    const reader = res.body!.getReader();
    let chunk = await reader.read();
    while (!chunk.done) chunk = await reader.read();
    // 真实 transformer flush 按 error.code 记录失败日志：503+isError=true+tokens=0，
    // 且不计入 Key 用量（修复前记录 200+isError=false）
    expect(prismaSpy.apiKeys.update).not.toHaveBeenCalled();
    expect(prismaSpy.requestLogs.create).toHaveBeenCalledTimes(1);
    const logData = prismaSpy.requestLogs.create.mock.calls[0][0].data;
    console.log("[repro] 流内 error 日志参数:", JSON.stringify({
      status: logData.status,
      isError: logData.isError,
      errorMessage: logData.errorMessage,
      tokens: logData.tokens,
    }));
    expect(logData.status).toBe(503);
    expect(logData.isError).toBe(true);
    expect(logData.tokens).toBe(0);
    expect(logData.errorMessage).toBe("upstream down");
  });
});
