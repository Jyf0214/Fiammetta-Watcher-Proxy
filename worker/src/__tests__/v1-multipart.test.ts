/**
 * V1 multipart 请求支持测试（三入口一致）
 *
 * 覆盖 #3 修复：images/edits、audio/transcriptions 等端点此前只做 JSON.parse，
 * 标准客户端必然发送 multipart 导致固定 400「请求体格式错误」，端点形同虚设。
 * 现在：
 * - model 从表单字段提取用于路由
 * - 原始字节 + 原始 Content-Type（含 boundary）透传上游
 * - multipart 请求体无法注入 JSON 模板字段，跳过模板应用
 * - 缺 model 返回 400（不发上游请求）
 *
 * 三入口行为一致：Worker 全量版（proxy.ts）/ lite 版（proxy-lite.ts）/ Pages 版（[[...v1]].ts）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { proxyV1Request } from "../proxy";
import { proxyV1RequestLite } from "../proxy-lite";
import handler from "../../../pages/api/v1/[[...v1]]";
import { routeRequest } from "../router";
import { routeRequestLite } from "../router-lite";
import { getNextKey, getRandomKeyExcept } from "../platform-keys";
import { loadTemplates } from "../request-templates";
import { validateApiKey } from "../auth";
import type { PlatformConfig } from "@/lib/types";
import type { WorkerEnv } from "../config";

// ==================== 依赖 Mock（三端并集） ====================

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(async () => ({})),
}));

vi.mock("../router", () => ({
  routeRequest: vi.fn(),
  freezeAutoModel: vi.fn(),
  isAutoModelRequest: vi.fn(() => false),
  getPlatformsForModel: vi.fn(() => []),
}));

vi.mock("../router-lite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../router-lite")>();
  return {
    ...actual,
    routeRequestLite: vi.fn(async () => null),
  };
});

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
  // Pages 版懒加载契约：返回 Promise<boolean>，handler 以 === true 判定置位
  loadWhitelist: vi.fn(async () => true),
  loadKeyStatusFromKV: vi.fn(async () => true),
}));

vi.mock("../load-balancer", () => ({
  recordSuccess: vi.fn(async () => {}),
  recordFailure: vi.fn(async () => {}),
  selectPlatform: vi.fn(async () => null),
  releaseHalfOpenPending: vi.fn(),
}));

vi.mock("@/lib/v1-rate-limit", () => ({
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
  resolveStreamErrorStatus: vi.fn(() => null),
  extractClientInfo: vi.fn(() => ({ ipAddress: "127.0.0.1", userAgent: "vitest" })),
}));

vi.mock("../auth", () => ({
  validateApiKey: vi.fn(async () => ({ apiKey: { id: "key-id", key: "sk-client-key", name: "client" } })),
}));

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB_TYPE: "d1" } })),
}));

// ==================== 测试辅助 ====================

const BOUNDARY = "----fwp-test-boundary-7f3a";
const MULTIPART_CT = `multipart/form-data; boundary=${BOUNDARY}`;

/** 构造 multipart 文本请求体（纯 ASCII：latin1 往返保字节序，三端解析一致） */
function buildMultipartBody(fields: Record<string, string>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
    );
  }
  parts.push(`--${BOUNDARY}--\r\n`);
  return parts.join("");
}

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
} as Parameters<typeof proxyV1Request>[2];

function buildMultipartRequest(): Request {
  const body = buildMultipartBody({ model: "gpt-4o" });
  return new Request("https://proxy.test/v1/images/edits", {
    method: "POST",
    headers: { "Content-Type": MULTIPART_CT },
    body,
  });
}

function buildMultipartRequestNoModel(): Request {
  const body = buildMultipartBody({ image: "abc" });
  return new Request("https://proxy.test/v1/images/edits", {
    method: "POST",
    headers: { "Content-Type": MULTIPART_CT },
    body,
  });
}

/** 断言 fetch 收到的上游请求为原始 multipart 透传（字节 + Content-Type 含 boundary） */
function expectMultipartForwarded(fetchMock: ReturnType<typeof vi.fn>, originalBody: string) {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("https://api.test.com/v1/images/edits");
  const headers = new Headers(init.headers);
  expect(headers.get("Content-Type")).toBe(MULTIPART_CT);
  expect(new TextDecoder().decode(init.body as Uint8Array)).toBe(originalBody);
}

// ==================== Worker 全量版 ====================

describe("Worker 全量版 proxyV1Request multipart", () => {
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

  it("multipart 请求：model 从表单提取路由，原始字节与 boundary 透传上游，跳过模板", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ id: "img-1", url: "https://example.com/x.png" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    const originalBody = buildMultipartBody({ model: "gpt-4o" });

    const res = await proxyV1Request(
      buildMultipartRequest(),
      { upstreamPath: "/images/edits", supportsStreaming: false },
      apiKey,
      env,
      ctx
    );

    expect(routeRequest).toHaveBeenCalledWith("gpt-4o", env.DB, { DB_TYPE: "d1" }, "chat");
    expectMultipartForwarded(vi.mocked(fetch), originalBody);
    // multipart 请求体无法注入 JSON 模板字段，跳过模板应用
    expect(loadTemplates).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("multipart 缺 model：400，不发上游请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await proxyV1Request(
      buildMultipartRequestNoModel(),
      { upstreamPath: "/images/edits", supportsStreaming: false },
      apiKey,
      env,
      ctx
    );

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(routeRequest).not.toHaveBeenCalled();
  });

  it("对照组：JSON 请求正常应用模板（证明模板跳过仅 multipart 生效）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    const res = await proxyV1Request(
      new Request("https://proxy.test/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      }),
      { upstreamPath: "/chat/completions", supportsStreaming: true },
      apiKey,
      env,
      ctx
    );

    expect(loadTemplates).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });
});

// ==================== lite 版 ====================

describe("lite 版 proxyV1RequestLite multipart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(routeRequestLite).mockResolvedValue({
      platform: makePlatform(),
      targetModel: "target-model",
    } as never);
    vi.mocked(getNextKey).mockReturnValue("sk-key1");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("multipart 请求：model 从表单提取路由，原始字节与 boundary 透传上游", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ id: "img-1", url: "https://example.com/x.png" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    const originalBody = buildMultipartBody({ model: "gpt-4o" });

    const res = await proxyV1RequestLite(
      buildMultipartRequest(),
      { upstreamPath: "/images/edits", supportsStreaming: false },
      apiKey,
      env,
      ctx
    );

    expect(routeRequestLite).toHaveBeenCalledWith("gpt-4o", env.DB, { DB_TYPE: "d1" }, "chat");
    expectMultipartForwarded(vi.mocked(fetch), originalBody);
    expect(res.status).toBe(200);
  });

  it("multipart 缺 model：400，不发上游请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await proxyV1RequestLite(
      buildMultipartRequestNoModel(),
      { upstreamPath: "/images/edits", supportsStreaming: false },
      apiKey,
      env,
      ctx
    );

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(routeRequestLite).not.toHaveBeenCalled();
  });
});

// ==================== Pages 版 ====================

/** 最小可迭代 NextApiRequest 模拟（parseRequestBody 用 for await 读 body） */
function makeMultipartReq(body: string, contentType: string): any {
  const buf = Buffer.from(body, "utf8");
  let offset = 0;
  return {
    headers: { "content-type": contentType, "content-length": String(buf.length) },
    query: { v1: ["images", "edits"] },
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
    on() {
      return res;
    },
    off() {
      return res;
    },
    once() {
      return res;
    },
    get statusCode() {
      return statusCode;
    },
  };
  return res;
}

describe("Pages 版 v1 代理 multipart", () => {
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
  });

  it("multipart 请求：model 从表单提取路由，原始字节与 boundary 透传上游，跳过模板", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ id: "img-1", url: "https://example.com/x.png" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    const originalBody = buildMultipartBody({ model: "gpt-4o" });

    const res = makeRes();
    await handler(makeMultipartReq(originalBody, MULTIPART_CT), res);

    expect(routeRequest).toHaveBeenCalledWith("gpt-4o", expect.anything(), expect.anything(), "chat");
    expectMultipartForwarded(vi.mocked(fetch), originalBody);
    // multipart 请求体无法注入 JSON 模板字段，跳过模板应用
    expect(loadTemplates).not.toHaveBeenCalled();
    expect(res.calls.length).toBe(1);
    expect(res.calls[0].status).toBe(200);
  });

  it("multipart 缺 model：400，不发上游请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = makeRes();
    await handler(makeMultipartReq(buildMultipartBody({ image: "abc" }), MULTIPART_CT), res);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(routeRequest).not.toHaveBeenCalled();
    expect(res.calls.length).toBe(1);
    expect(res.calls[0].status).toBe(400);
  });
});