/**
 * 单平台多协议 — 共享层单测
 *
 * 覆盖三段核心逻辑：
 * 1. resolvePlatformProtocols：types JSON 字符串 → PlatformProtocol[] 解析
 * 2. selectProtocolForRequest：在 types[] 中按端点/模型名挑选协议
 * 3. resolveUpstreamUrl 新签名：协议枚举决定上游 URL 形态
 *
 * 旧数据兼容性是这套改造的核心契约：types 缺失/非法/空数组都必须回退到 [type]，
 * 不能让任何旧平台突然失去可用协议。
 */

import { describe, it, expect } from "vitest";
import { resolvePlatformProtocols } from "../types";
import { selectProtocolForRequest } from "../proxy-core/protocol-selector";
import { resolveUpstreamUrl, buildUpstreamFetchUrl } from "../../worker/src/proxy-core/forward-context";

describe("resolvePlatformProtocols — 单平台多协议解析", () => {
  it("types 缺失时回退到 [type]", () => {
    expect(resolvePlatformProtocols(null, "anthropic")).toEqual(["anthropic"]);
    expect(resolvePlatformProtocols(undefined, "openai")).toEqual(["openai"]);
  });

  it("types 为空字符串时回退到 [type]", () => {
    expect(resolvePlatformProtocols("", "gemini")).toEqual(["gemini"]);
    expect(resolvePlatformProtocols("   ", "azure")).toEqual(["azure"]);
  });

  it("types 非法 JSON 时回退到 [type]（fail-closed）", () => {
    expect(resolvePlatformProtocols("not-json", "openai")).toEqual(["openai"]);
    expect(resolvePlatformProtocols("{", "custom")).toEqual(["custom"]);
  });

  it("types 合法 JSON 数组时去重保序，且 type 永远在结果里", () => {
    expect(resolvePlatformProtocols('["openai","anthropic"]', "openai")).toEqual([
      "openai",
      "anthropic",
    ]);
    // type 不在数组里时强制加到首项
    expect(resolvePlatformProtocols('["anthropic","openai"]', "openai")).toEqual([
      "openai",
      "anthropic",
    ]);
  });

  it("types 全非法元素时回退到 [type]", () => {
    expect(resolvePlatformProtocols('["bogus","openaix"]', "openai")).toEqual([
      "openai",
    ]);
  });

  it("types 含重复元素时去重（保首次出现顺序）", () => {
    expect(
      resolvePlatformProtocols('["openai","anthropic","openai"]', "openai")
    ).toEqual(["openai", "anthropic"]);
  });

  it("types 含非数组合法 JSON 时回退到 [type]", () => {
    expect(resolvePlatformProtocols('"openai"', "openai")).toEqual(["openai"]);
    expect(resolvePlatformProtocols('{"k":1}', "anthropic")).toEqual([
      "anthropic",
    ]);
  });
});

describe("selectProtocolForRequest — 协议挑选算法", () => {
  it("/v1/messages 端点优先选 anthropic", () => {
    expect(
      selectProtocolForRequest({
        types: ["openai", "anthropic"],
        upstreamPath: "/v1/messages",
        targetModel: "claude-sonnet-4-5",
      })
    ).toBe("anthropic");
  });

  it("/v1/chat/completions 端点优先选 openai", () => {
    expect(
      selectProtocolForRequest({
        types: ["anthropic", "openai"],
        upstreamPath: "/v1/chat/completions",
        targetModel: "gpt-4o",
      })
    ).toBe("openai");
  });

  it("/v1/responses 端点优先选 openai", () => {
    expect(
      selectProtocolForRequest({
        types: ["anthropic", "openai"],
        upstreamPath: "/v1/responses",
        targetModel: "gpt-4o",
      })
    ).toBe("openai");
  });

  it("端点理想协议不在 types 中时，按 types[0] 回退", () => {
    expect(
      selectProtocolForRequest({
        types: ["anthropic"],
        upstreamPath: "/v1/chat/completions",
        targetModel: "gpt-4o",
      })
    ).toBe("anthropic");
  });

  it("Gemini 模型名（models/gemini-...）启发式匹配 gemini", () => {
    expect(
      selectProtocolForRequest({
        types: ["openai", "gemini"],
        upstreamPath: "/v1/chat/completions",
        targetModel: "models/gemini-2.0-flash",
      })
    ).toBe("gemini");
  });

  it("Gemini 模型名（无前缀）也匹配", () => {
    expect(
      selectProtocolForRequest({
        types: ["openai", "gemini"],
        upstreamPath: "/v1/chat/completions",
        targetModel: "gemini-2.0-flash",
      })
    ).toBe("gemini");
  });

  it("types 为空时保底 openai（最广泛的兼容默认）", () => {
    expect(
      selectProtocolForRequest({
        types: [],
        upstreamPath: "/v1/messages",
        targetModel: "claude-sonnet-4-5",
      })
    ).toBe("openai");
  });

  it("端点带查询参数时正则仍能匹配（防 baseUrl 形如 /v1/messages?beta=true）", () => {
    expect(
      selectProtocolForRequest({
        types: ["anthropic", "openai"],
        upstreamPath: "/v1/messages?beta=true",
        targetModel: "claude-sonnet-4-5",
      })
    ).toBe("anthropic");
  });
});

describe("resolveUpstreamUrl 新签名 — 协议枚举驱动 URL", () => {
  it("anthropic 协议指向 /v1/messages（忽略 upstreamPath）", () => {
    expect(
      resolveUpstreamUrl("https://api.example.com", "/v1/chat/completions", "anthropic")
    ).toBe("https://api.example.com/v1/messages");
  });

  it("openai 协议 = baseUrl + 原样路径", () => {
    expect(
      resolveUpstreamUrl("https://api.openai.com/v1", "/v1/chat/completions", "openai")
    ).toBe("https://api.openai.com/v1/v1/chat/completions");
  });

  it("azure/custom 协议同 openai 走 baseUrl + path", () => {
    expect(
      resolveUpstreamUrl("https://x.example/", "/v1/chat/completions", "azure")
    ).toBe("https://x.example/v1/chat/completions");
    expect(
      resolveUpstreamUrl("https://x.example/", "/v1/chat/completions", "custom")
    ).toBe("https://x.example/v1/chat/completions");
  });

  it("gemini 协议指向 /v1beta/models/{model}:generateContent", () => {
    expect(
      resolveUpstreamUrl("https://generativelanguage.googleapis.com", "/v1/messages", "gemini", "gemini-2.0-flash")
    ).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"
    );
  });

  it("gemini 协议拒绝非法模型名（路径注入防御）", () => {
    expect(() =>
      resolveUpstreamUrl("https://example.com", "/v1/messages", "gemini", "../etc/passwd")
    ).toThrow(/Gemini 模型名含非法字符/);
  });

  it("gemini 协议缺 targetModel 时直接 throw（不再用 unknown 兜底）", () => {
    expect(() =>
      resolveUpstreamUrl("https://example.com", "/v1/messages", "gemini")
    ).toThrow(/必须提供 targetModel/);
  });

  it("baseUrl 尾部斜杠会被去掉", () => {
    expect(
      resolveUpstreamUrl("https://x.example/v1/", "/v1/chat/completions", "openai")
    ).toBe("https://x.example/v1/v1/chat/completions");
  });

  it("向后兼容：boolean true 仍解析为 anthropic", () => {
    expect(
      resolveUpstreamUrl("https://api.example.com", "/v1/chat/completions", true)
    ).toBe("https://api.example.com/v1/messages");
  });

  it("向后兼容：boolean false + legacyIsGemini=true 解析为 gemini", () => {
    expect(
      resolveUpstreamUrl(
        "https://generativelanguage.googleapis.com",
        "/v1/chat/completions",
        false,
        "gemini-2.0-flash",
        true
      )
    ).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"
    );
  });
});

describe("buildUpstreamFetchUrl — 协议鉴权/查询参数注入（三端共享 P0 修复）", () => {
  it("openai 协议不追加额外参数", () => {
    expect(
      buildUpstreamFetchUrl(
        "https://api.openai.com/v1",
        "/v1/chat/completions",
        "openai",
        "gpt-4o",
        "sk-abc",
        true
      )
    ).toBe("https://api.openai.com/v1/v1/chat/completions");
  });

  it("anthropic 协议不追加额外参数（Key 由 buildUpstreamFetchHeaders 处理）", () => {
    expect(
      buildUpstreamFetchUrl(
        "https://api.anthropic.com",
        "/v1/chat/completions",
        "anthropic",
        "claude-sonnet-4-5",
        "sk-ant-xxx",
        true
      )
    ).toBe("https://api.anthropic.com/v1/messages");
  });

  it("gemini 协议非流式：?key=... 注入（Auth Header 无法鉴权）", () => {
    expect(
      buildUpstreamFetchUrl(
        "https://generativelanguage.googleapis.com",
        "/v1/messages",
        "gemini",
        "gemini-2.0-flash",
        "AIza-test",
        false
      )
    ).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=AIza-test"
    );
  });

  it("gemini 协议流式：端点切到 :streamGenerateContent + ?alt=sse&key=... 注入", () => {
    // Gemini 文档要求流式必须用 :streamGenerateContent 而非 :generateContent 配合 ?alt=sse
    // ——否则上游返回非预期格式或 404。这是 Gemini API 硬约束
    expect(
      buildUpstreamFetchUrl(
        "https://generativelanguage.googleapis.com",
        "/v1/messages",
        "gemini",
        "gemini-2.0-flash",
        "AIza-test",
        true
      )
    ).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=AIza-test"
    );
  });

  it("gemini Key 含特殊字符必须 URL 编码（+ / = 不会破坏查询）", () => {
    expect(
      buildUpstreamFetchUrl(
        "https://generativelanguage.googleapis.com",
        "/v1/messages",
        "gemini",
        "gemini-2.0-flash",
        "a+b/c=d",
        false
      )
    ).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=a%2Bb%2Fc%3Dd"
    );
  });

  it("gemini 缺 targetModel 时直接 throw（与 resolveUpstreamUrl 一致）", () => {
    expect(() =>
      buildUpstreamFetchUrl(
        "https://example.com",
        "/v1/messages",
        "gemini",
        "", // 空字符串
        "k",
        false
      )
    ).toThrow(/必须提供 targetModel/);
  });

  it("向后兼容：boolean true + legacyIsGemini=false 走 anthropic 路径", () => {
    expect(
      buildUpstreamFetchUrl(
        "https://api.example.com",
        "/v1/chat/completions",
        true,
        "claude-sonnet-4-5",
        "k",
        false
      )
    ).toBe("https://api.example.com/v1/messages");
  });

  it("向后兼容：boolean false + legacyIsGemini=true 走 gemini 路径", () => {
    expect(
      buildUpstreamFetchUrl(
        "https://generativelanguage.googleapis.com",
        "/v1/chat/completions",
        false,
        "gemini-2.0-flash",
        "AIza-test",
        false,
        true
      )
    ).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=AIza-test"
    );
  });
});
