/**
 * 模型类型检测 + 路由缓存过滤测试
 *
 * 第二个 describe 直接测试生产代码 router.ts 导出的 buildPlatformModelCache
 * （真实缓存构建逻辑），不再复制实现。启用的过滤由查询条件（enabled: true）保证，
 * 函数本身只负责按平台分组。
 */

import { describe, it, expect, vi } from "vitest";
import { detectModelType } from "@/lib/detect-model-type";
import { buildPlatformModelCache } from "../router";

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(),
}));

describe("detectModelType", () => {
  it("默认返回 chat", () => {
    expect(detectModelType("gpt-4o")).toBe("chat");
    expect(detectModelType("claude-3-opus")).toBe("chat");
    expect(detectModelType("qwen-turbo")).toBe("chat");
  });

  it("embedding 类型检测", () => {
    expect(detectModelType("text-embedding-3-small")).toBe("embedding");
    expect(detectModelType("nvidia/embed-v1")).toBe("embedding");
    expect(detectModelType("bge-vector")).toBe("embedding");
  });

  it("image 类型检测", () => {
    expect(detectModelType("dall-e-3")).toBe("image");
    expect(detectModelType("stable-diffusion-xl")).toBe("image");
    expect(detectModelType("midjourney-v6")).toBe("image");
    expect(detectModelType("flux-schnell")).toBe("image");
    expect(detectModelType("google/diffusiongemma-26b-a4b-it")).toBe("image");
    expect(detectModelType("agnes-image-2.0-flash")).toBe("image");
    expect(detectModelType("gpt-image-1")).toBe("image");
  });

  it("audio 类型检测", () => {
    expect(detectModelType("whisper-large-v3")).toBe("audio");
    expect(detectModelType("tts-1")).toBe("audio");
    expect(detectModelType("speech-recognition")).toBe("audio");
    expect(detectModelType("voice-cloning")).toBe("audio");
  });

  it("video 类型检测", () => {
    expect(detectModelType("sora-pro")).toBe("video");
    expect(detectModelType("kling-v2")).toBe("video");
    expect(detectModelType("runway-gen3")).toBe("video");
    expect(detectModelType("agnes-video-v2.0")).toBe("video");
    expect(detectModelType("veo-3")).toBe("video");
    expect(detectModelType("wan2.1-t2v")).toBe("video");
    expect(detectModelType("hailuo-01")).toBe("video");
    expect(detectModelType("nvidia/ai-synthetic-video-detector")).toBe("video");
  });

  it("moderation 类型检测", () => {
    expect(detectModelType("content-moderation-v2")).toBe("moderation");
    expect(detectModelType("text-safety")).toBe("moderation");
    expect(detectModelType("content-filter")).toBe("moderation");
  });

  it("嵌套关键词按优先级匹配", () => {
    // embedding > image > audio > video > moderation
    expect(detectModelType("video-embedding")).toBe("embedding");  // embedding 优先级最高
    expect(detectModelType("image-audio")).toBe("image");          // image > audio
    expect(detectModelType("audio-moderation")).toBe("audio");     // audio > moderation
  });

  it("大小写不敏感", () => {
    expect(detectModelType("DALL-E-3")).toBe("image");
    expect(detectModelType("WHISPER-LARGE")).toBe("audio");
    expect(detectModelType("TEXT-EMBEDDING-3")).toBe("embedding");
  });
});

describe("平台模型缓存构建（真实 buildPlatformModelCache）", () => {
  it("按平台分组构建缓存", () => {
    const cache = buildPlatformModelCache([
      { platformId: "p1", modelId: "gpt-4o" },
      { platformId: "p1", modelId: "embedding-3" },
      { platformId: "p2", modelId: "model-c" },
    ]);

    expect(cache.get("p1")?.has("gpt-4o")).toBe(true);
    expect(cache.get("p1")?.has("embedding-3")).toBe(true);
    expect(cache.get("p1")?.size).toBe(2);
    expect(cache.get("p2")?.size).toBe(1);
  });

  it("空输入返回空缓存", () => {
    const cache = buildPlatformModelCache([]);
    expect(cache.size).toBe(0);
  });

  it("同一平台重复模型按 Set 去重", () => {
    const cache = buildPlatformModelCache([
      { platformId: "p1", modelId: "gpt-4o" },
      { platformId: "p1", modelId: "gpt-4o" },
    ]);
    expect(cache.get("p1")?.size).toBe(1);
  });
});
