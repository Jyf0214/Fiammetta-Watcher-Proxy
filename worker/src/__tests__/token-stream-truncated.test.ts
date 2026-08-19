/**
 * createUsageTransformer 上游流截断（EOF 但未收到 [DONE]）日志语义测试
 *
 * 部分上游（如 zen-proxy 某些入口）对长思考流返回 200 + 部分 SSE 后直接 EOF，
 * 不发送 data: [DONE]。此前 flush 一律记 200 成功，坏平台永远不会被熔断，
 * 负载均衡反复撞上它。修复后应记 status=502 / isError=true / tokens=0，
 * 且触发 recordFailure 熔断计数，不计入 Key 用量。
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
    platformId: "truncated-platform",
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

describe("createUsageTransformer 上游流截断", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("EOF 无 [DONE]（有内容 chunk）→ 记 502 + isError=true + tokens=0，不更新 Key 用量", async () => {
    const prisma = makePrisma();
    await runTransformer(prisma, [
      'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"more"}}]}\n\n',
    ]);

    expect(prisma.apiKeys.update).not.toHaveBeenCalled();
    expect(prisma.requestLogs.create).toHaveBeenCalledTimes(1);
    const log = prisma.requestLogs.create.mock.calls[0][0].data;
    expect(log.status).toBe(502);
    expect(log.isError).toBe(true);
    expect(log.tokens).toBe(0);
    expect(log.promptTokens).toBe(0);
    expect(log.completionTokens).toBe(0);
    expect(log.errorMessage).toContain("[DONE]");
  });

  it("截断前已收到 usage 也按 502 记失败（不该按成功）", async () => {
    const prisma = makePrisma();
    await runTransformer(prisma, [
      'data: {"choices":[{"delta":{"reasoning_content":"a"}}]}\n\n',
      'data: {"usage":{"total_tokens":50,"prompt_tokens":10,"completion_tokens":40}}\n\n',
      // 无 [DONE] 直接 EOF
    ]);

    expect(prisma.apiKeys.update).not.toHaveBeenCalled();
    const log = prisma.requestLogs.create.mock.calls[0][0].data;
    expect(log.status).toBe(502);
    expect(log.isError).toBe(true);
    expect(log.tokens).toBe(0);
  });

  it("正常结束（有 [DONE]）→ 200 成功，不受截断检测影响", async () => {
    const prisma = makePrisma();
    await runTransformer(prisma, [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"usage":{"total_tokens":10,"prompt_tokens":4,"completion_tokens":6}}\n\n',
      "data: [DONE]\n\n",
    ]);

    expect(prisma.apiKeys.update).toHaveBeenCalledTimes(1);
    const log = prisma.requestLogs.create.mock.calls[0][0].data;
    expect(log.status).toBe(200);
    expect(log.isError).toBe(false);
    expect(log.tokens).toBe(10);
  });

  it("流内 error 事件仍按错误码记录（截断检测不覆盖 error）", async () => {
    const prisma = makePrisma();
    await runTransformer(prisma, [
      'data: {"error":{"message":"upstream down","code":503}}\n\n',
      // 无 [DONE] 直接 EOF
    ]);

    expect(prisma.apiKeys.update).not.toHaveBeenCalled();
    const log = prisma.requestLogs.create.mock.calls[0][0].data;
    expect(log.status).toBe(503);
    expect(log.isError).toBe(true);
    expect(log.errorMessage).toBe("upstream down");
  });
});
