/**
 * enrichUsageWithCost 单元测试
 *
 * 验证 OpenAI 标准 usage.cost 字段注入：
 * - 上游已自报 cost（OpenRouter/部分 OpenAI 兼容）→ 注入到 usage.cost
 * - cost 为 null → 不变更响应体（价格表估算不入 usage.cost，避免与实时计费混淆）
 * - 非 JSON 响应 / 缺 usage / usage 非对象 → 原样返回，绝不破坏主响应
 * - Anthropic 协议分支不调用本函数（仅 OpenAI 透传路径注入）
 */

import { describe, it, expect } from "vitest";

const { enrichUsageWithCost } = await import("../token");

describe("enrichUsageWithCost", () => {
  it("注入上游自报的 cost 到 usage.cost（OpenRouter/OpenAI 兼容）", () => {
    const body = JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    });
    const out = enrichUsageWithCost(body, 0.00042);
    expect(JSON.parse(out).usage.cost).toBe(0.00042);
    // 其他字段保留
    expect(JSON.parse(out).usage.prompt_tokens).toBe(10);
    expect(JSON.parse(out).id).toBe("chatcmpl-1");
  });

  it("cost 为 null 时原样返回，不写入估算值", () => {
    const body = JSON.stringify({ usage: { total_tokens: 30 } });
    const out = enrichUsageWithCost(body, null);
    expect(out).toBe(body);
    expect("cost" in JSON.parse(out).usage).toBe(false);
  });

  it("非 JSON 响应体原样返回，不抛错", () => {
    const body = "not json {";
    expect(() => enrichUsageWithCost(body, 0.01)).not.toThrow();
    expect(enrichUsageWithCost(body, 0.01)).toBe(body);
  });

  it("响应体缺 usage 字段时原样返回", () => {
    const body = JSON.stringify({ id: "x", choices: [] });
    const out = enrichUsageWithCost(body, 0.01);
    expect(out).toBe(body);
  });

  it("usage 非对象（数组/字符串）时原样返回", () => {
    expect(enrichUsageWithCost(JSON.stringify({ usage: [] }), 0.01)).toBe(
      JSON.stringify({ usage: [] })
    );
    expect(enrichUsageWithCost(JSON.stringify({ usage: "x" }), 0.01)).toBe(
      JSON.stringify({ usage: "x" })
    );
  });

  it("顶层非对象（数字/字符串/null）原样返回", () => {
    expect(enrichUsageWithCost("null", 0.01)).toBe("null");
    expect(enrichUsageWithCost("42", 0.01)).toBe("42");
    expect(enrichUsageWithCost('"hi"', 0.01)).toBe('"hi"');
  });

  it("覆盖已存在的 usage.cost（上游与本代理冲突时以本代理为准——本代理为后置注入点）", () => {
    const body = JSON.stringify({ usage: { total_tokens: 30, cost: 0.99 } });
    const out = enrichUsageWithCost(body, 0.00042);
    expect(JSON.parse(out).usage.cost).toBe(0.00042);
  });
});
