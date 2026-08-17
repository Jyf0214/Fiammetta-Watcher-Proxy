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
  loadWhitelist: vi.fn(async () => {}),
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

  it("首次请求加载白名单一次，后续请求不再重复加载", async () => {
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

    await handler(req, res);
    expect(loadWhitelist).toHaveBeenCalledTimes(1);
    expect(loadWhitelist).toHaveBeenCalledWith(expect.anything(), expect.anything());

    // 第二次请求：懒加载标志已置位，不重复加载
    await handler(req, res);
    expect(loadWhitelist).toHaveBeenCalledTimes(1);
  });
});