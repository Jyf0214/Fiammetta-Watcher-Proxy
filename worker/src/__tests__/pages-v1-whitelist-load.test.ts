/**
 * Pages 版 v1 代理白名单懒加载回归测试
 *
 * recordKeyError / banKey 的白名单豁免依赖 isKeyWhitelisted / isPlatformWhitelisted
 * 内存集合，须由 loadWhitelist 填充。此前 pages/api/v1/[[...v1]].ts 从不调用
 * loadWhitelist，EdgeOne/Docker 等非 Worker 部署模式下白名单豁免永不生效
 * （白名单 Key 仍会 401×3 / 402 一次被自动禁用）。
 *
 * 独立测试文件：模块级 whitelistLoaded 标志初始为 false，可在单用例内验证
 * 「首次请求加载一次、后续请求跳过」的完整懒加载语义。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler from "../../../pages/api/v1/[[...v1]]";
import { validateApiKey } from "../../../worker/src/auth";
import { routeRequest } from "../../../worker/src/router";
import { getNextKey, loadWhitelist } from "../../../worker/src/platform-keys";
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
  // W10 契约：loadWhitelist/loadKeyStatusFromKV 返回 Promise<boolean>（失败 false 不抛异常），
  // v1.ts 以 === true 判定置位——mock 必须返回 true 才能模拟成功路径
  loadWhitelist: vi.fn(async () => true),
  loadKeyStatusFromKV: vi.fn(async () => true),
}));

vi.mock("../../../worker/src/load-balancer", () => ({
  recordSuccess: vi.fn(async () => {}),
  recordFailure: vi.fn(async () => {}),
  // 补齐 handler 实际导入的其余导出：此前缺失导致触达这些路径时
  // TypeError 被外层 catch 吞成 500，用例在异常路径上假通过
  selectPlatform: vi.fn(() => null),
  releaseHalfOpenPending: vi.fn(() => {}),
  recordPlatform429: vi.fn(),
  checkAndUpdateCircuitBreakerState: vi.fn(() => "closed"),
}));

vi.mock("@/lib/v1-rate-limit", () => ({
  checkPlatformRpm: vi.fn(async () => ({ allowed: true })),
  checkApiKeyRpm: vi.fn(async () => ({ allowed: true })),
  checkPlatformTpm: vi.fn(async () => ({ allowed: true })),
  checkApiKeyTpm: vi.fn(async () => ({ allowed: true })),
  // 门禁统一化后 handler 经 runLimitGate 适配器间接引用归还函数：
  // mock 覆盖完整导入面，避免拒绝路径误触 undefined
  releasePlatformRpm: vi.fn(async () => {}),
  releasePlatformTpm: vi.fn(async () => {}),
}));

vi.mock("../../../worker/src/request-templates", () => ({
  loadTemplates: vi.fn(async () => []),
  getApplicableTemplates: vi.fn(() => []),
  applyTemplates: vi.fn((b: unknown) => b),
}));

// 补齐 handler 实际导入的导出（extractClientInfo 此前缺失导致每次请求都在
// proxyV1RequestPages 开头抛 TypeError）；detectResponsesStreamEvent 用真实实现
vi.mock("../../../worker/src/token", async () => {
  const actual = await vi.importActual<typeof import("../../../worker/src/token")>("../../../worker/src/token");
  return {
    recordRequestLog: vi.fn(async () => {}),
    extractUsage: vi.fn(() => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 })),
    updateKeyUsage: vi.fn(async () => {}),
    extractClientInfo: vi.fn(() => ({ ipAddress: "127.0.0.1", userAgent: "vitest" })),
    detectResponsesStreamEvent: actual.detectResponsesStreamEvent,
  };
});

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
  let statusCode = 200;
  const res: any = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    json() {
      return res;
    },
    send() {
      return res;
    },
    write() {
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

describe("Pages 版 v1 白名单懒加载", () => {
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("加载失败不置位、下次请求重试；成功后置位不再重复加载（W10 回归）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    const req = makeReq({ model: "m", messages: [{ role: "user", content: "hi" }] });
    const res = makeRes();

    // 失败（false）：不置位 → 每次请求都重新加载
    vi.mocked(loadWhitelist).mockResolvedValue(false);
    await handler(req, res);
    await handler(req, res);
    expect(loadWhitelist).toHaveBeenCalledTimes(2);

    // 恢复成功：本次请求加载后置位
    vi.mocked(loadWhitelist).mockResolvedValue(true);
    await handler(req, res);
    expect(loadWhitelist).toHaveBeenCalledTimes(3);

    // 已置位：后续请求不再加载
    await handler(req, res);
    expect(loadWhitelist).toHaveBeenCalledTimes(3);
  });
});