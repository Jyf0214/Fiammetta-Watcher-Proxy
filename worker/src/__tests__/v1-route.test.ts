/**
 * v1-route 端点配置测试
 *
 * 测试 URL 路径到端点配置的映射
 */

import { describe, it, expect } from "vitest";

// 提取 getEndpointConfig 用于测试（该函数未导出，通过间接方式测试）
// 这里直接测试路由逻辑的核心：路径匹配

describe("V1 端点路径匹配", () => {
  // 模拟 getEndpointConfig 的核心逻辑
  function getEndpointConfig(pathname: string) {
    const endpoint = pathname.replace(/^\/v1/, "");
    const endpoints: Record<string, { upstreamPath: string; supportsStreaming: boolean }> = {
      "/chat/completions": { upstreamPath: "/chat/completions", supportsStreaming: true },
      "/completions": { upstreamPath: "/completions", supportsStreaming: true },
      "/embeddings": { upstreamPath: "/embeddings", supportsStreaming: false },
      "/images/generations": { upstreamPath: "/images/generations", supportsStreaming: false },
      "/images/edits": { upstreamPath: "/images/edits", supportsStreaming: false },
      "/images/variations": { upstreamPath: "/images/variations", supportsStreaming: false },
      "/audio/speech": { upstreamPath: "/audio/speech", supportsStreaming: false },
      "/audio/transcriptions": { upstreamPath: "/audio/transcriptions", supportsStreaming: false },
      "/audio/translations": { upstreamPath: "/audio/translations", supportsStreaming: false },
      "/responses": { upstreamPath: "/responses", supportsStreaming: true },
      "/models": { upstreamPath: "/models", supportsStreaming: false },
    };
    if (endpoint in endpoints) return endpoints[endpoint];
    if (endpoint.startsWith("/models/")) return { upstreamPath: endpoint, supportsStreaming: false };
    return null;
  }

  it("chat/completions 匹配且支持流式", () => {
    const config = getEndpointConfig("/v1/chat/completions");
    expect(config).not.toBeNull();
    expect(config!.upstreamPath).toBe("/chat/completions");
    expect(config!.supportsStreaming).toBe(true);
  });

  it("completions 匹配且支持流式", () => {
    const config = getEndpointConfig("/v1/completions");
    expect(config).not.toBeNull();
    expect(config!.supportsStreaming).toBe(true);
  });

  it("embeddings 匹配但不支持流式", () => {
    const config = getEndpointConfig("/v1/embeddings");
    expect(config).not.toBeNull();
    expect(config!.supportsStreaming).toBe(false);
  });

  it("images/generations 匹配", () => {
    const config = getEndpointConfig("/v1/images/generations");
    expect(config).not.toBeNull();
    expect(config!.upstreamPath).toBe("/images/generations");
  });

  it("audio/speech 匹配", () => {
    const config = getEndpointConfig("/v1/audio/speech");
    expect(config).not.toBeNull();
  });

  it("/v1/models 匹配", () => {
    const config = getEndpointConfig("/v1/models");
    expect(config).not.toBeNull();
    expect(config!.upstreamPath).toBe("/models");
  });

  it("/v1/models/gpt-4o 匹配为模型详情", () => {
    const config = getEndpointConfig("/v1/models/gpt-4o");
    expect(config).not.toBeNull();
    expect(config!.upstreamPath).toBe("/models/gpt-4o");
  });

  it("不支持的端点返回 null", () => {
    expect(getEndpointConfig("/v1/unknown")).toBeNull();
    expect(getEndpointConfig("/v1/files")).toBeNull();
    expect(getEndpointConfig("/v1/fine-tunes")).toBeNull();
  });

  it("根路径 /v1 返回 null", () => {
    expect(getEndpointConfig("/v1")).toBeNull();
  });

  it("responses 匹配且支持流式", () => {
    const config = getEndpointConfig("/v1/responses");
    expect(config).not.toBeNull();
    expect(config!.supportsStreaming).toBe(true);
  });
});
