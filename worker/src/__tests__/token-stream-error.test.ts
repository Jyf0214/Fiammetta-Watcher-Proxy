/**
 * createUsageTransformer 流内 error 事件日志语义测试
 *
 * 上游网关对失败请求可能返回 200 + SSE 流内 `data: {"error":{"code":503}}`，
 * HTTP 头无法反映失败。修复后 flush 应按 error.code 记录失败日志：
 * status=503 / isError=true / tokens=0，且不计入 Key 用量。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createUsageTransformer } from "../token";
import { createDb } from "@/lib/prisma";
import { banKey, recordKeyError } from "../platform-keys";

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(),
}));

vi.mock("../platform-keys", () => ({
  banKey: vi.fn(async () => {}),
  recordKeyError: vi.fn(async () => {}),
  isPlatformWhitelisted: vi.fn(() => false),
}));

// token.ts 依赖 recordFailure：不 mock 会走真实实现访问 mock prisma 不存在的
// platforms 键，内部 catch 打印 "[circuit-breaker] 更新平台状态失败" 噪音
vi.mock("../load-balancer", () => ({
  recordFailure: vi.fn(async () => {}),
  recordSuccess: vi.fn(async () => {}),
  recordPlatform429: vi.fn(),
  releaseHalfOpenPending: vi.fn(() => {}),
}));

// 批量写入缓冲器 mock（替代直接 prisma 写入）
const mockBufferKeyUsage = vi.fn();
const mockBufferRequestLog = vi.fn();
vi.mock("../batched-writer", () => ({
  bufferKeyUsage: (...args: any[]) => mockBufferKeyUsage(...args),
  bufferRequestLog: (...args: any[]) => mockBufferRequestLog(...args),
  initBatchedWriter: vi.fn(),
}));

const encoder = new TextEncoder();

async function runTransformer(
  chunks: string[],
  overrides: Partial<Parameters<typeof createUsageTransformer>[0]> = {}
): Promise<void> {
  vi.mocked(createDb).mockResolvedValue({} as never);
  const transformer = createUsageTransformer({
    keyId: "key-id",
    keyName: "client",
    platformId: "test-platform",
    model: "test-model",
    startTime: Date.now(),
    endpoint: "/chat/completions",
    db: {} as D1Database,
    ...overrides,
  });
  await new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  })
    .pipeThrough(transformer)
    .pipeTo(new WritableStream());
}

describe("createUsageTransformer 流内 error", () => {
  beforeEach(() => {
    mockBufferKeyUsage.mockClear();
    mockBufferRequestLog.mockClear();
    vi.clearAllMocks();
  });

  it("流内 error 事件 → 日志记 error.code=503 + isError=true + tokens=0，且不更新 Key 用量", async () => {
    await runTransformer([
      'data: {"error":{"message":"upstream down","code":503}}\n\n',
      "data: [DONE]\n\n",
    ]);

    expect(mockBufferKeyUsage).not.toHaveBeenCalled();
    expect(mockBufferRequestLog).toHaveBeenCalledTimes(1);
    const log = mockBufferRequestLog.mock.calls[0][0];
    expect(log.status).toBe(503);
    expect(log.isError).toBe(true);
    expect(log.tokens).toBe(0);
    expect(log.promptTokens).toBe(0);
    expect(log.completionTokens).toBe(0);
    expect(log.errorMessage).toBe("upstream down");
  });

  it("字符串 code 同样解析（'429'）", async () => {
    await runTransformer([
      'data: {"error":{"message":"rate limited","code":"429"}}\n\n',
      "data: [DONE]\n\n",
    ]);

    const log = mockBufferRequestLog.mock.calls[0][0];
    expect(log.status).toBe(429);
    expect(log.isError).toBe(true);
    expect(log.tokens).toBe(0);
  });

  it("无效 code（非 400-599）兜底 502 流内 error（此前回落 200 成功路径）", async () => {
    await runTransformer([
      'data: {"error":{"message":"warning","code":200}}\n\n',
      'data: {"usage":{"total_tokens":12,"prompt_tokens":5,"completion_tokens":7}}\n\n',
      "data: [DONE]\n\n",
    ]);

    // error 对象存在但 code 无效：resolveStreamErrorStatus 兜底 502，
    // 记失败且不计入 Key 用量（此前静默忽略、误记 200 成功并计入用量）
    expect(mockBufferKeyUsage).not.toHaveBeenCalled();
    const log = mockBufferRequestLog.mock.calls[0][0];
    expect(log.status).toBe(502);
    expect(log.isError).toBe(true);
    expect(log.tokens).toBe(0);
  });

  it("浮点 code（503.5）兜底 502 流内 error", async () => {
    await runTransformer([
      'data: {"error":{"message":"odd code","code":503.5}}\n\n',
      "data: [DONE]\n\n",
    ]);

    // 不抛错、日志仍写入（status 502 为合法 Int，无 Prisma 校验风险）
    expect(mockBufferRequestLog).toHaveBeenCalledTimes(1);
    const log = mockBufferRequestLog.mock.calls[0][0];
    expect(log.status).toBe(502);
    expect(log.isError).toBe(true);
  });

  it("数组 code 兜底 502 流内 error", async () => {
    await runTransformer([
      'data: {"error":{"message":"array code","code":["503"]}}\n\n',
      "data: [DONE]\n\n",
    ]);

    const log = mockBufferRequestLog.mock.calls[0][0];
    expect(log.status).toBe(502);
    expect(log.isError).toBe(true);
  });

  it("error 事件与 usage 并存时 error 优先（不计 Key 用量）", async () => {
    await runTransformer([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"usage":{"total_tokens":99,"prompt_tokens":50,"completion_tokens":49}}\n\n',
      'data: {"error":{"message":"late failure","code":503}}\n\n',
      "data: [DONE]\n\n",
    ]);

    expect(mockBufferKeyUsage).not.toHaveBeenCalled();
    const log = mockBufferRequestLog.mock.calls[0][0];
    expect(log.status).toBe(503);
    expect(log.isError).toBe(true);
    expect(log.tokens).toBe(0);
    expect(log.errorMessage).toBe("late failure");
  });

  it("正常流（无 error，有 usage）→ 200 + 更新 Key 用量", async () => {
    await runTransformer([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"usage":{"total_tokens":10,"prompt_tokens":4,"completion_tokens":6}}\n\n',
      "data: [DONE]\n\n",
    ]);

    expect(mockBufferKeyUsage).toHaveBeenCalledTimes(1);
    expect(mockBufferKeyUsage).toHaveBeenCalledWith("key-id", 10);
    const log = mockBufferRequestLog.mock.calls[0][0];
    expect(log.status).toBe(200);
    expect(log.isError).toBe(false);
    expect(log.tokens).toBe(10);
  });

  it("流内 429 密钥类错误：传入 kv 时 banKey 同时持久化到 KV（与 HTTP 429 路径对齐）", async () => {
    const kv = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => {}),
    } as unknown as KVNamespace;

    await runTransformer([
      'data: {"error":{"message":"rate limited","code":429}}\n\n',
      "data: [DONE]\n\n",
    ], {
      key: "sk-key1",
      kv,
    });

    // banKey 收到 kv：写 KV 持久化（此前只写内存，CF 部署下管理后台不可见、冷启动封禁丢失）
    expect(banKey).toHaveBeenCalledWith("sk-key1", undefined, "test-platform", kv);
    expect(recordKeyError).toHaveBeenCalledWith("sk-key1", 429, "test-platform", expect.anything(), undefined);
    // 日志仍按 error.code 记失败
    const log = mockBufferRequestLog.mock.calls[0][0];
    expect(log.status).toBe(429);
    expect(log.isError).toBe(true);
  });

  it("流内 429 但不传 kv：banKey 仅内存封禁（非 CF 部署兼容，kv 参数为 undefined）", async () => {
    await runTransformer([
      'data: {"error":{"message":"rate limited","code":429}}\n\n',
      "data: [DONE]\n\n",
    ], {
      key: "sk-key1",
    });

    expect(banKey).toHaveBeenCalledWith("sk-key1", undefined, "test-platform", undefined);
    expect(recordKeyError).toHaveBeenCalled();
  });

  it("流内非密钥类错误（503）：不触发 banKey/recordKeyError", async () => {
    const kv = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => {}),
    } as unknown as KVNamespace;

    await runTransformer([
      'data: {"error":{"message":"upstream down","code":503}}\n\n',
      "data: [DONE]\n\n",
    ], {
      key: "sk-key1",
      kv,
    });

    expect(banKey).not.toHaveBeenCalled();
    expect(recordKeyError).not.toHaveBeenCalled();
  });
});
