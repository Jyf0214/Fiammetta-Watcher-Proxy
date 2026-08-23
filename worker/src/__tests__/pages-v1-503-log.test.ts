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
import { getNextKey, getRandomKeyExcept, banKey, recordKeyError, isPlatformWhitelisted } from "../../../worker/src/platform-keys";
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
  isPlatformWhitelisted: vi.fn(() => false),
  // W10 契约：loadWhitelist/loadKeyStatusFromKV 返回 Promise<boolean>，v1.ts 以 === true 判定置位
  loadWhitelist: vi.fn(async () => true),
  loadKeyStatusFromKV: vi.fn(async () => true),
}));

vi.mock("../../../worker/src/load-balancer", () => ({
  recordSuccess: vi.fn(async () => {}),
  recordFailure: vi.fn(async () => {}),
  recordPlatform429: vi.fn(),
  releaseHalfOpenPending: vi.fn(() => {}),
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
  extractClientInfo: vi.fn(() => ({ ipAddress: "127.0.0.1", userAgent: "vitest" })),
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
  const listeners: Record<string, Array<() => void>> = {};
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
    // Pages 流式分支监听 res close（客户端断开取消上游流），测试桩需提供
    on(ev: string, cb: () => void) {
      (listeners[ev] ||= []).push(cb);
      return res;
    },
    off() {
      return res;
    },
    once() {
      return res;
    },
    // 模拟客户端断开：触发 handler 注册的 close 回调（clientClosed=true + 取消上游流）
    emitClose() {
      (listeners["close"] || []).forEach((cb) => cb());
    },
    get statusCode() {
      return statusCode;
    },
  };
  return res;
}

/**
 * 在首次写入时模拟客户端断开（与上游首个 chunk 到达几乎同时）的 response 桩：
 * 首个 write 触发 close，验证客户端断开后空完成/截断分支不指责平台（不熔断）
 */
function makeResClosingOnFirstWrite(): any {
  const res = makeRes();
  const origWrite = res.write.bind(res);
  let wrote = false;
  res.write = (s: unknown) => {
    if (!wrote) {
      wrote = true;
      res.emitClose();
    }
    return origWrite(s);
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
    expect(recordFailure).toHaveBeenCalledWith("test-platform", expect.anything(), expect.anything());
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
    expect(recordFailure).toHaveBeenCalledWith("test-platform", expect.anything(), expect.anything());
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
    // 非密钥类码（503）不触发 Key 级处理，仅平台熔断
    expect(banKey).not.toHaveBeenCalled();
    expect(recordKeyError).not.toHaveBeenCalled();
    expect(recordFailure).toHaveBeenCalledWith("test-platform", expect.anything(), expect.anything());
  });

  it("修复验证：流内 error 429 → 封禁当前平台 Key + 累计错误计数（W1 回归）", async () => {
    const encoder = new TextEncoder();
    const errStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"error":{"message":"rate limited","code":429}}\n\n')
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

    // 日志按流内错误码记录（修复前记录 200）
    expect(recordRequestLog).toHaveBeenCalledTimes(1);
    const logParams = vi.mocked(recordRequestLog).mock.calls[0][0];
    expect(logParams.status).toBe(429);
    expect(logParams.isError).toBe(true);
    // W1 核心：流内密钥类状态码与 HTTP 重试路径对齐——封禁当前平台 Key + 错误计数
    // （此前只记日志，密钥自动禁用机制在流式场景完全失效）
    expect(banKey).toHaveBeenCalledWith("sk-key1", undefined, "test-platform", undefined);
    expect(recordKeyError).toHaveBeenCalledWith("sk-key1", 429, "test-platform", expect.anything(), expect.anything());
    expect(recordFailure).toHaveBeenCalledWith("test-platform", expect.anything(), expect.anything());
  });

  it("修复验证：空完成（流内仅 [DONE] 无内容）→ 日志记 502 + isError=true + 平台熔断", async () => {
    const encoder = new TextEncoder();
    const emptyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(emptyStream, { status: 200, headers: { "Content-Type": "text/event-stream" } })
      )
    );

    const req = makeReq({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] });
    const res = makeRes();
    await handler(req, res);

    // 下游收到 200（响应头已发出，无法改状态）；日志按空完成记 502 失败
    // （此前记 200 成功，坏平台评分不降、负载均衡反复撞上它）
    expect(recordRequestLog).toHaveBeenCalledTimes(1);
    const logParams = vi.mocked(recordRequestLog).mock.calls[0][0];
    expect(logParams.status).toBe(502);
    expect(logParams.isError).toBe(true);
    expect(logParams.tokens).toBe(0);
    expect(logParams.errorMessage).toContain("空完成");
    // 非白名单平台：空完成触发平台熔断（软失败也降级，防止反复撞上）
    expect(recordFailure).toHaveBeenCalledTimes(1);
    expect(recordFailure).toHaveBeenCalledWith("test-platform", expect.anything(), expect.anything());
    // 空完成非密钥类错误，不触发 Key 级处理
    expect(banKey).not.toHaveBeenCalled();
    expect(recordKeyError).not.toHaveBeenCalled();
  });

  it("修复验证：白名单平台空完成 → 日志记 502 但不触发熔断（软失败豁免）", async () => {
    vi.mocked(isPlatformWhitelisted).mockReturnValue(true);
    const encoder = new TextEncoder();
    const emptyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(emptyStream, { status: 200, headers: { "Content-Type": "text/event-stream" } })
      )
    );

    const req = makeReq({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] });
    const res = makeRes();
    await handler(req, res);

    // 白名单=永不封禁语义：空完成（软失败）不触发熔断，平台评分不降；
    // 但日志如实记失败（客户端确实收到空完成）
    expect(recordFailure).not.toHaveBeenCalled();
    expect(recordRequestLog).toHaveBeenCalledTimes(1);
    const logParams = vi.mocked(recordRequestLog).mock.calls[0][0];
    expect(logParams.status).toBe(502);
    expect(logParams.isError).toBe(true);
    expect(logParams.tokens).toBe(0);
  });

  it("修复验证：客户端断开 + 空完成流（[DONE] 无内容）→ 不记失败不熔断（与截断分支的 clientClosed 语义对齐）", async () => {
    const encoder = new TextEncoder();
    const emptyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(emptyStream, { status: 200, headers: { "Content-Type": "text/event-stream" } })
      )
    );

    const req = makeReq({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] });
    const res = makeResClosingOnFirstWrite();
    await handler(req, res);

    // 客户端断开是下游原因，无法确认上游是否真的返回空流：不触发熔断
    // （修复前空完成分支无 !clientClosed 守卫，会记 502 并熔断平台）
    expect(recordFailure).not.toHaveBeenCalled();
    // 日志按成功路径记录（与截断分支客户端断开时落入 else 的行为一致）
    expect(recordRequestLog).toHaveBeenCalledTimes(1);
    const logParams = vi.mocked(recordRequestLog).mock.calls[0][0];
    expect(logParams.status).toBe(200);
    expect(logParams.isError).toBe(false);
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
    // W4：空闲超时与 EOF 截断同属上游失败，触发平台熔断（此前只补日志不打分）
    expect(recordFailure).toHaveBeenCalledWith("test-platform", expect.anything(), expect.anything());
  });

  it("HTTP 429 四轮耗尽：每轮（含最后一轮）封禁 Key + 错误计数，日志 4 条，下游 429", async () => {
    // fetch 恒定 429：attempt 0..3 共 4 轮；修复前最后一轮跳过 banKey/
    // recordKeyError，该 Key 逃过封禁与计数，自动禁用阈值被系统性稀释
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    const req = makeReq({ model: "m", messages: [{ role: "user", content: "hi" }] });
    const res = makeRes();
    await handler(req, res);

    // 下游真实 429（重试耗尽后透传上游状态）
    expect(res.calls.length).toBe(1);
    expect(res.calls[0].status).toBe(429);

    // 每轮封禁当前 Key：第 1 轮 sk-key1，后 3 轮换到 sk-key2（mock 恒返回）
    expect(banKey).toHaveBeenCalledTimes(4);
    expect(vi.mocked(banKey).mock.calls.map((c) => c[0])).toEqual([
      "sk-key1",
      "sk-key2",
      "sk-key2",
      "sk-key2",
    ]);
    // 每轮错误计数（429→+1），最后一轮同样累计
    expect(recordKeyError).toHaveBeenCalledTimes(4);
    for (const c of vi.mocked(recordKeyError).mock.calls) {
      expect(c[1]).toBe(429);
      expect(c[2]).toBe("test-platform");
    }
    // 日志 4 条（前 3 轮重试日志 + 第 4 轮最终日志），status 均为真实 429
    expect(recordRequestLog).toHaveBeenCalledTimes(4);
    for (const logParams of vi.mocked(recordRequestLog).mock.calls.map((c) => c[0])) {
      expect(logParams.status).toBe(429);
      expect(logParams.isError).toBe(true);
    }
    // 仅最终轮触发平台熔断（中间轮次由重试覆盖，不打分）
    expect(recordFailure).toHaveBeenCalledTimes(1);
  });

  it("网络错误（fetch 拒绝，非超时）→ 下游 502 + 补记 status=502 日志 + 平台熔断", async () => {
    // 修复前：直连路径 throw 冒泡返回 500 且 request_logs 零记录；
    // 修复后统一补记日志并返回 502（与 Worker 全量版/lite 版一致，status 记 502
    // 而非 0——后台按状态码筛选/统计口径三端统一）
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );

    const req = makeReq({ model: "m", messages: [{ role: "user", content: "hi" }] });
    const res = makeRes();
    await handler(req, res);

    expect(res.calls.length).toBe(1);
    expect(res.calls[0].status).toBe(502);
    // 网络错误不触发 Key 级处理（非密钥类状态码）
    expect(banKey).not.toHaveBeenCalled();
    expect(recordKeyError).not.toHaveBeenCalled();
    // 补记日志：status=502 + isError + 平台熔断
    expect(recordRequestLog).toHaveBeenCalledTimes(1);
    const logParams = vi.mocked(recordRequestLog).mock.calls[0][0];
    expect(logParams.status).toBe(502);
    expect(logParams.isError).toBe(true);
    expect(logParams.errorMessage).toBe("fetch failed");
    expect(recordFailure).toHaveBeenCalledWith("test-platform", expect.anything(), expect.anything());
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
