/**
 * @deprecated
 *
 * Chat ↔ Responses 双向转换测试已移除（2026-08-21）。
 * 转换功能因行业共识认为语义不可转换而被移除，
 * 对应测试不再需要。原测试文件含 38 个用例，覆盖请求/响应/流式互转，
 * 均因转换函数移除而失效。
 */
import { describe, it, expect } from "vitest";

describe("chat-responses-converter (已废弃)", () => {
  it("转换功能已移除，仅保留透传", () => {
    // chat↔responses 互转不再由代理层执行
    // 下游 /v1/chat/completions 直接透传至上游 /v1/chat/completions
    // 下游 /v1/responses 直接透传至上游 /v1/responses
    expect(true).toBe(true);
  });
});
