/**
 * 模型类型检测 + 路由缓存过滤测试
 */

import { describe, it, expect } from "vitest";

// 模拟 detectModelType（从 models.ts 提取的核心逻辑）
function detectModelType(modelId: string): string {
  const id = modelId.toLowerCase();
  if (/embed|embedding|vector|text-embedding/.test(id)) return "embedding";
  if (/dall-e|stable-diffusion|midjourney|flux|image/.test(id)) return "image";
  if (/whisper|tts|speech|audio|voice/.test(id)) return "audio";
  if (/video|sora|runway|kling|pika|luma/.test(id)) return "video";
  if (/moderation|safety|content-moderation|content-safety|content-filter/.test(id)) return "moderation";
  return "chat";
}

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

describe("模型启禁用过滤（模拟 Worker 逻辑）", () => {
  interface MockModel {
    platformId: string;
    modelId: string;
    enabled: boolean;
  }

  // 模拟 Worker 的 refreshCache 过滤逻辑
  function buildModelCache(models: MockModel[]): Map<string, Set<string>> {
    const cache = new Map<string, Set<string>>();
    for (const m of models) {
      if (!m.enabled) continue; // 只缓存启用的模型
      let set = cache.get(m.platformId);
      if (!set) {
        set = new Set();
        cache.set(m.platformId, set);
      }
      set.add(m.modelId);
    }
    return cache;
  }

  it("禁用的模型不进入缓存", () => {
    const models: MockModel[] = [
      { platformId: "p1", modelId: "gpt-4o", enabled: true },
      { platformId: "p1", modelId: "gpt-3.5-turbo", enabled: false },
      { platformId: "p1", modelId: "embedding-3", enabled: true },
    ];
    const cache = buildModelCache(models);
    const p1Models = cache.get("p1")!;

    expect(p1Models.has("gpt-4o")).toBe(true);
    expect(p1Models.has("gpt-3.5-turbo")).toBe(false); // 被过滤
    expect(p1Models.has("embedding-3")).toBe(true);
    expect(p1Models.size).toBe(2);
  });

  it("全部禁用时平台无模型", () => {
    const models: MockModel[] = [
      { platformId: "p1", modelId: "gpt-4o", enabled: false },
    ];
    const cache = buildModelCache(models);
    expect(cache.has("p1")).toBe(false);
  });

  it("多平台独立过滤", () => {
    const models: MockModel[] = [
      { platformId: "p1", modelId: "model-a", enabled: true },
      { platformId: "p2", modelId: "model-b", enabled: false },
      { platformId: "p2", modelId: "model-c", enabled: true },
    ];
    const cache = buildModelCache(models);

    expect(cache.get("p1")?.size).toBe(1);
    expect(cache.get("p2")?.size).toBe(1); // model-b 被过滤
    expect(cache.get("p2")?.has("model-c")).toBe(true);
  });
});
