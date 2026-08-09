/**
 * v1-route 端点配置测试
 *
 * 直接测试生产代码 v1-route.ts 导出的 getEndpointConfig（URL 路径 → 端点配置映射），
 * 不再复制路由逻辑，避免实现分叉导致测试失守。
 */

import { describe, it, expect } from "vitest";
import { getEndpointConfig } from "../v1-route";

describe("V1 端点路径匹配", () => {
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

  it("/v1/messages 匹配 Anthropic 协议并转换为 chat/completions", () => {
    const config = getEndpointConfig("/v1/messages");
    expect(config).not.toBeNull();
    expect(config!.upstreamPath).toBe("/chat/completions");
    expect(config!.supportsStreaming).toBe(true);
    expect(config!.protocol).toBe("anthropic");
    expect(typeof config!.buildUpstreamBody).toBe("function");
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
