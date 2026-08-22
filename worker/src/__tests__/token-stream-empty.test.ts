/**
 * createUsageTransformer 空完成（200 + 无内容无 usage）日志语义测试
 *
 * 部分上游（如 zen-proxy 免费模型高峰排队超时、对代理 IP 降级）返回
 * 200 + SSE 流正常 [DONE] 收尾，但全程没有任何 content/reasoning_content
 * 内容，也不带 usage。这种"伪成功"流此前不触发空流哨兵（首块非空）、
 * 流内 error（无 error 对象）、截断检测（有 [DONE]）、空闲超时（数据在
 * 时限内到达）任何一道检测，被记成 200 成功——管理后台常见
 * "200 + 0 tokens + 数十秒首字延迟"即此场景，且坏平台评分不降、
 * 负载均衡反复撞上它。
 *
 * 修复后：sawDone + 无有效内容 → 判定空完成，记 status=502 / isError=true /
 * tokens=0，并触发 recordFailure 熔断，不计入 Key 用量。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createUsageTransformer } from "../token";
import { createDb } from "@/lib/prisma";
import { recordFailure } from "../load-balancer";
import { isPlatformWhitelisted } from "../platform-keys";

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(),
}));

vi.mock("../load-balancer", () => ({
  recordFailure: vi.fn(async () => {}),
  recordSuccess: vi.fn(async () => {}),
  proxyStatKey: vi.fn(() => "stat-key"),
}));

vi.mock("../platform-keys", () => ({
  isPlatformWhitelisted: vi.fn(() => false),
  banKey: vi.fn(async () => {}),
  recordKeyError: vi.fn(async () => {}),
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
    platformId: "empty-platform",
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

describe("createUsageTransformer 空完成检测", () => {
  beforeEach(() => {
    mockBufferKeyUsage.mockClear();
    mockBufferRequestLog.mockClear();
    vi.clearAllMocks();
  });

  it("仅有 [DONE] 的流（无内容无 usage）→ 记 502 + isError=true + 触发熔断 + 不计入 Key 用量", async () => {
    await runTransformer([
      "data: [DONE]\n\n",
    ]);

    expect(mockBufferKeyUsage).not.toHaveBeenCalled();
    expect(recordFailure).toHaveBeenCalledTimes(1);
    expect(recordFailure).toHaveBeenCalledWith("empty-platform", expect.any(Object), undefined);
    expect(mockBufferRequestLog).toHaveBeenCalledTimes(1);
    const log = mockBufferRequestLog.mock.calls[0][0];
    expect(log.status).toBe(502);
    expect(log.isError).toBe(true);
    expect(log.tokens).toBe(0);
    expect(log.promptTokens).toBe(0);
    expect(log.completionTokens).toBe(0);
    expect(log.errorMessage).toContain("空完成");
  });

  it("空 JSON data + [DONE]（用户日志场景：首块到达即结束）→ 记 502 空完成", async () => {
    await runTransformer([
      'data: {}\n\n',
      "data: [DONE]\n\n",
    ]);

    expect(recordFailure).toHaveBeenCalledTimes(1);
    const log = mockBufferRequestLog.mock.calls[0][0];
    expect(log.status).toBe(502);
    expect(log.isError).toBe(true);
    expect(log.tokens).toBe(0);
    expect(log.errorMessage).toContain("空完成");
  });

  it("仅有 usage 无内容（total>0）→ 仍按空完成记失败（客户端无输出）", async () => {
    await runTransformer([
      'data: {"usage":{"total_tokens":12,"prompt_tokens":5,"completion_tokens":7}}\n\n',
      "data: [DONE]\n\n",
    ]);

    expect(mockBufferKeyUsage).not.toHaveBeenCalled();
    expect(recordFailure).toHaveBeenCalledTimes(1);
    const log = mockBufferRequestLog.mock.calls[0][0];
    expect(log.status).toBe(502);
    expect(log.isError).toBe(true);
    expect(log.tokens).toBe(0);
  });

  it("白名单平台空完成：软失败豁免熔断（recordFailure 不调用），但日志仍记 502 失败", async () => {
    vi.mocked(isPlatformWhitelisted).mockReturnValue(true);
    await runTransformer([
      "data: [DONE]\n\n",
    ]);

    // 白名单=永不封禁语义：空完成（软失败）不触发熔断，平台评分不降；
    // 但日志如实记失败（客户端确实收到空完成）
    expect(recordFailure).not.toHaveBeenCalled();
    expect(mockBufferRequestLog).toHaveBeenCalledTimes(1);
    const log = mockBufferRequestLog.mock.calls[0][0];
    expect(log.status).toBe(502);
    expect(log.isError).toBe(true);
    expect(log.tokens).toBe(0);
    expect(log.errorMessage).toContain("空完成");
  });

  it("白名单平台截断（硬失败）→ 仍触发熔断（软失败豁免只覆盖空完成）", async () => {
    vi.mocked(isPlatformWhitelisted).mockReturnValue(true);
    await runTransformer([
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      // 无 [DONE] 直接 EOF
    ]);

    expect(recordFailure).toHaveBeenCalledTimes(1);
    const log = mockBufferRequestLog.mock.calls[0][0];
    expect(log.status).toBe(502);
    expect(log.isError).toBe(true);
  });

  it("有 content 无 usage（上游不发 usage 的正常流）→ 不误伤：记 200 成功", async () => {
    await runTransformer([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);

    expect(recordFailure).not.toHaveBeenCalled();
    const log = mockBufferRequestLog.mock.calls[0][0];
    expect(log.status).toBe(200);
    expect(log.isError).toBe(false);
    // 无 usage 也无 maxTokensEstimate 兜底：tokens 为 0（现状，不影响成功判定）
    expect(log.tokens).toBe(0);
  });

  it("有 reasoning_content 无 content（纯思考流）→ 不误伤：记 200 成功", async () => {
    await runTransformer([
      'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"more"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);

    expect(recordFailure).not.toHaveBeenCalled();
    const log = mockBufferRequestLog.mock.calls[0][0];
    expect(log.status).toBe(200);
    expect(log.isError).toBe(false);
  });

  it("纯 tool_calls 流（无文本内容）→ 不误伤：记 200 成功（工具调用也是有效输出）", async () => {
    await runTransformer([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ]);

    // 纯工具调用流没有 content/reasoning_content，但 tool_calls 增量是有效输出，
    // 不得误判为空完成（此前会记 502 并熔断，打断 agent 工具调用流程）
    expect(recordFailure).not.toHaveBeenCalled();
    const log = mockBufferRequestLog.mock.calls[0][0];
    expect(log.status).toBe(200);
    expect(log.isError).toBe(false);
  });

  it("完全空输入（无任何 chunk）→ 按截断记 502 + 熔断 + 不计入 Key 用量", async () => {
    await runTransformer([]);

    // 真实链路（proxy.ts 首块 read 即 done）已拦截为空响应，此处防御直接调用
    // transformer 的场景：无 [DONE] 且无任何数据 → 按截断失败处理（此前记 200 成功）
    expect(recordFailure).toHaveBeenCalledTimes(1);
    expect(mockBufferKeyUsage).not.toHaveBeenCalled();
    expect(mockBufferRequestLog).toHaveBeenCalledTimes(1);
    const log = mockBufferRequestLog.mock.calls[0][0];
    expect(log.status).toBe(502);
    expect(log.isError).toBe(true);
    expect(log.tokens).toBe(0);
    expect(log.errorMessage).toContain("截断");
  });

  it("正常流（content + usage + [DONE]）→ 不受空完成检测影响：记 200 且计入 Key 用量", async () => {
    await runTransformer([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"usage":{"total_tokens":10,"prompt_tokens":4,"completion_tokens":6}}\n\n',
      "data: [DONE]\n\n",
    ]);

    expect(recordFailure).not.toHaveBeenCalled();
    expect(mockBufferKeyUsage).toHaveBeenCalledTimes(1);
    expect(mockBufferKeyUsage).toHaveBeenCalledWith("key-id", 10);
    const log = mockBufferRequestLog.mock.calls[0][0];
    expect(log.status).toBe(200);
    expect(log.isError).toBe(false);
    expect(log.tokens).toBe(10);
  });
});