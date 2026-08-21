/**
 * 接口映射（API 转换）测试
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  matchApiPattern,
  getApplicableApiMapping,
  resolveTargetModel,
  type ApiMapping,
} from "../api-mappings";

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(),
}));

describe("matchApiPattern", () => {
  it("精确匹配", () => {
    expect(matchApiPattern("gpt-4o", "gpt-4o")).toBe(true);
    expect(matchApiPattern("gpt-4o", "gpt-4o-mini")).toBe(false);
  });

  it("通配符 *", () => {
    expect(matchApiPattern("my-model-123", "my-model*")).toBe(true);
    expect(matchApiPattern("other-model", "my-model*")).toBe(false);
    expect(matchApiPattern("any", "*")).toBe(true);
  });

  it("大小写不敏感", () => {
    expect(matchApiPattern("GPT-4o", "gpt-*")).toBe(true);
  });

  it("空模式不匹配", () => {
    expect(matchApiPattern("gpt-4o", "")).toBe(false);
  });
});

describe("resolveTargetModel", () => {
  it("同模：空 targetModel 返回原模型", () => {
    const m: ApiMapping = {
      id: "1",
      name: "test",
      description: "",
      pattern: "old-model*",
      targetModel: "",
      sourceApi: "chat",
      targetApi: "responses",
      enabled: true,
    };
    expect(resolveTargetModel(m, "old-model-123")).toBe("old-model-123");
  });

  it("同模：* 返回原模型", () => {
    const m: ApiMapping = {
      id: "1",
      name: "test",
      description: "",
      pattern: "*",
      targetModel: "*",
      sourceApi: "chat",
      targetApi: "responses",
      enabled: true,
    };
    expect(resolveTargetModel(m, "any-model")).toBe("any-model");
  });

  it("固定目标模型", () => {
    const m: ApiMapping = {
      id: "1",
      name: "test",
      description: "",
      pattern: "old-model",
      targetModel: "gpt-5",
      sourceApi: "chat",
      targetApi: "responses",
      enabled: true,
    };
    expect(resolveTargetModel(m, "old-model")).toBe("gpt-5");
  });

  it("通配符后缀拼接", () => {
    const m: ApiMapping = {
      id: "1",
      name: "test",
      description: "",
      pattern: "old-*",
      targetModel: "new-",
      sourceApi: "chat",
      targetApi: "responses",
      enabled: true,
    };
    expect(resolveTargetModel(m, "old-123")).toBe("new-123");
  });

  it("通配符目标以 * 结尾", () => {
    const m: ApiMapping = {
      id: "1",
      name: "test",
      description: "",
      pattern: "old-*",
      targetModel: "new-*",
      sourceApi: "chat",
      targetApi: "responses",
      enabled: true,
    };
    expect(resolveTargetModel(m, "old-123")).toBe("new-123");
  });
});

describe("getApplicableApiMapping", () => {
  const mappings: ApiMapping[] = [
    {
      id: "1",
      name: "chat->responses",
      description: "",
      pattern: "old-model*",
      targetModel: "gpt-5",
      sourceApi: "chat",
      targetApi: "responses",
      enabled: true,
    },
    {
      id: "2",
      name: "responses->chat",
      description: "",
      pattern: "new-model*",
      targetModel: "gpt-4o",
      sourceApi: "responses",
      targetApi: "chat",
      enabled: true,
    },
    {
      id: "3",
      name: "disabled",
      description: "",
      pattern: "old-model*",
      targetModel: "gpt-5",
      sourceApi: "chat",
      targetApi: "responses",
      enabled: false,
    },
  ];

  it("匹配 chat->responses", () => {
    const result = getApplicableApiMapping(mappings, "old-model-123", "chat");
    expect(result?.id).toBe("1");
  });

  it("匹配 responses->chat", () => {
    const result = getApplicableApiMapping(mappings, "new-model-123", "responses");
    expect(result?.id).toBe("2");
  });

  it("来源 API 不匹配时不命中", () => {
    const result = getApplicableApiMapping(mappings, "old-model-123", "responses");
    expect(result).toBeNull();
  });

  it("禁用的映射不命中", () => {
    const result = getApplicableApiMapping(mappings, "old-model-123", "chat");
    // 应命中 id 1 而非禁用的 id 3
    expect(result?.id).toBe("1");
  });

  it("无匹配返回 null", () => {
    const result = getApplicableApiMapping(mappings, "unknown-model", "chat");
    expect(result).toBeNull();
  });

  it("按存储顺序返回首个匹配", () => {
    const dup: ApiMapping[] = [
      {
        id: "a",
        name: "a",
        description: "",
        pattern: "model*",
        targetModel: "gpt-5",
        sourceApi: "chat",
        targetApi: "responses",
        enabled: true,
      },
      {
        id: "b",
        name: "b",
        description: "",
        pattern: "model*",
        targetModel: "gpt-4o",
        sourceApi: "chat",
        targetApi: "responses",
        enabled: true,
      },
    ];
    const result = getApplicableApiMapping(dup, "model-123", "chat");
    expect(result?.id).toBe("a");
  });
});

describe("loadApiMappings 缓存", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("updatedAt 变化时重载", async () => {
    let value = JSON.stringify([
      { id: "1", name: "m1", pattern: "a*", targetModel: "b", sourceApi: "chat", targetApi: "responses", enabled: true },
    ]);
    let updatedAt = 1000;
    let fullReads = 0;

    const { createDb } = await import("@/lib/prisma");
    const mockCreateDb = vi.mocked(createDb);
    mockCreateDb.mockResolvedValue({
      configs: {
        findFirst: vi.fn((args: any) => {
          if ("value" in args.select) {
            fullReads++;
            return Promise.resolve({ value, updatedAt });
          }
          return Promise.resolve({ updatedAt });
        }),
      },
    } as any);

    const { loadApiMappings } = await import("../api-mappings");
    const db = {} as any;

    const first = await loadApiMappings(db);
    expect(first).toHaveLength(1);
    expect(fullReads).toBe(1);

    await loadApiMappings(db);
    expect(fullReads).toBe(1);

    value = JSON.stringify([
      { id: "1", name: "m1", pattern: "a*", targetModel: "c", sourceApi: "chat", targetApi: "responses", enabled: true },
    ]);
    updatedAt = 2000;
    await loadApiMappings(db);
    expect(fullReads).toBe(2);
  });
});
