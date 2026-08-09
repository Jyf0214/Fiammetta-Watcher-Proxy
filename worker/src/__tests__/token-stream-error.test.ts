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

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(),
}));

function makePrisma() {
  return {
    apiKeys: { update: vi.fn(async () => ({})) },
    requestLogs: { create: vi.fn(async (_args: { data: any }) => ({})) },
  };
}

const encoder = new TextEncoder();

async function runTransformer(
  prisma: ReturnType<typeof makePrisma>,
  chunks: string[],
  overrides: Partial<Parameters<typeof createUsageTransformer>[0]> = {}
): Promise<void> {
  vi.mocked(createDb).mockResolvedValue(prisma as never);
  const transformer = createUsageTransformer({
    keyId: "key-id",
    keyName: "client",
    platformId: "test-platform",
    model: "test-model",
    startTime: Date.now(),
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
    vi.clearAllMocks();
  });

  it("流内 error 事件 → 日志记 error.code=503 + isError=true + tokens=0，且不更新 Key 用量", async () => {
    const prisma = makePrisma();
    await runTransformer(prisma, [
      'data: {"error":{"message":"upstream down","code":503}}\n\n',
      "data: [DONE]\n\n",
    ]);

    expect(prisma.apiKeys.update).not.toHaveBeenCalled();
    expect(prisma.requestLogs.create).toHaveBeenCalledTimes(1);
    const log = prisma.requestLogs.create.mock.calls[0][0].data;
    expect(log.status).toBe(503);
    expect(log.isError).toBe(true);
    expect(log.tokens).toBe(0);
    expect(log.promptTokens).toBe(0);
    expect(log.completionTokens).toBe(0);
    expect(log.errorMessage).toBe("upstream down");
  });

  it("字符串 code 同样解析（'429'）", async () => {
    const prisma = makePrisma();
    await runTransformer(prisma, [
      'data: {"error":{"message":"rate limited","code":"429"}}\n\n',
      "data: [DONE]\n\n",
    ]);

    const log = prisma.requestLogs.create.mock.calls[0][0].data;
    expect(log.status).toBe(429);
    expect(log.isError).toBe(true);
    expect(log.tokens).toBe(0);
  });

  it("无效 code（非 400-599）不视为流内错误，回退 200 成功路径", async () => {
    const prisma = makePrisma();
    await runTransformer(prisma, [
      'data: {"error":{"message":"warning","code":200}}\n\n',
      'data: {"usage":{"total_tokens":12,"prompt_tokens":5,"completion_tokens":7}}\n\n',
      "data: [DONE]\n\n",
    ]);

    expect(prisma.apiKeys.update).toHaveBeenCalledTimes(1);
    const log = prisma.requestLogs.create.mock.calls[0][0].data;
    expect(log.status).toBe(200);
    expect(log.isError).toBe(false);
    expect(log.tokens).toBe(12);
  });

  it("浮点 code（503.5）不视为错误码：避免 Prisma Int 校验失败导致整条日志丢失", async () => {
    const prisma = makePrisma();
    await runTransformer(prisma, [
      'data: {"error":{"message":"odd code","code":503.5}}\n\n',
      "data: [DONE]\n\n",
    ]);

    // 不抛错、日志仍写入（回退 200 成功形态）
    expect(prisma.requestLogs.create).toHaveBeenCalledTimes(1);
    const log = prisma.requestLogs.create.mock.calls[0][0].data;
    expect(log.status).toBe(200);
    expect(log.isError).toBe(false);
  });

  it("数组 code（[\"503\"]）不被 String 化误解析为 503", async () => {
    const prisma = makePrisma();
    await runTransformer(prisma, [
      'data: {"error":{"message":"array code","code":["503"]}}\n\n',
      "data: [DONE]\n\n",
    ]);

    const log = prisma.requestLogs.create.mock.calls[0][0].data;
    expect(log.status).toBe(200);
    expect(log.isError).toBe(false);
  });

  it("error 事件与 usage 并存时 error 优先（不计 Key 用量）", async () => {
    const prisma = makePrisma();
    await runTransformer(prisma, [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"usage":{"total_tokens":99,"prompt_tokens":50,"completion_tokens":49}}\n\n',
      'data: {"error":{"message":"late failure","code":503}}\n\n',
      "data: [DONE]\n\n",
    ]);

    expect(prisma.apiKeys.update).not.toHaveBeenCalled();
    const log = prisma.requestLogs.create.mock.calls[0][0].data;
    expect(log.status).toBe(503);
    expect(log.isError).toBe(true);
    expect(log.tokens).toBe(0);
    expect(log.errorMessage).toBe("late failure");
  });

  it("正常流（无 error，有 usage）→ 200 + 更新 Key 用量", async () => {
    const prisma = makePrisma();
    await runTransformer(prisma, [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"usage":{"total_tokens":10,"prompt_tokens":4,"completion_tokens":6}}\n\n',
      "data: [DONE]\n\n",
    ]);

    expect(prisma.apiKeys.update).toHaveBeenCalledWith({
      where: { id: "key-id" },
      data: expect.objectContaining({
        usedTokens: { increment: 10 },
        callUsed: { increment: 1 },
      }),
    });
    const log = prisma.requestLogs.create.mock.calls[0][0].data;
    expect(log.status).toBe(200);
    expect(log.isError).toBe(false);
    expect(log.tokens).toBe(10);
  });
});
