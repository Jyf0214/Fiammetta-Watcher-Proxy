/**
 * 请求模板匹配与应用测试
 */

import { describe, it, expect } from "vitest";
import { matchModel, getApplicableTemplates, applyTemplates, type RequestTemplate } from "../request-templates";

describe("matchModel", () => {
  it("精确匹配", () => {
    expect(matchModel("gpt-4o", ["gpt-4o"])).toBe(true);
    expect(matchModel("gpt-4o", ["gpt-4o-mini"])).toBe(false);
  });

  it("通配符 * 匹配所有", () => {
    expect(matchModel("gpt-4o", ["*"])).toBe(true);
    expect(matchModel("claude-3-opus", ["*"])).toBe(true);
    expect(matchModel("any-model-here", ["*"])).toBe(true);
  });

  it("前缀通配符 gpt-*", () => {
    expect(matchModel("gpt-4o", ["gpt-*"])).toBe(true);
    expect(matchModel("gpt-4o-mini", ["gpt-*"])).toBe(true);
    expect(matchModel("gpt-3.5-turbo", ["gpt-*"])).toBe(true);
    expect(matchModel("claude-3-opus", ["gpt-*"])).toBe(false);
  });

  it("后缀通配符 *-flash", () => {
    expect(matchModel("gemini-2.0-flash", ["*-flash"])).toBe(true);
    expect(matchModel("agnes-2.0-flash", ["*-flash"])).toBe(true);
    expect(matchModel("gpt-4o", ["*-flash"])).toBe(false);
  });

  it("中间通配符 gpt-*-latest", () => {
    expect(matchModel("gpt-4o-latest", ["gpt-*-latest"])).toBe(true);
    expect(matchModel("gpt-3.5-latest", ["gpt-*-latest"])).toBe(true);
    expect(matchModel("gpt-4o", ["gpt-*-latest"])).toBe(false);
  });

  it("多模式匹配", () => {
    expect(matchModel("gpt-4o", ["claude-*", "gpt-*"])).toBe(true);
    expect(matchModel("claude-3-opus", ["claude-*", "gpt-*"])).toBe(true);
    expect(matchModel("gemini-pro", ["claude-*", "gpt-*"])).toBe(false);
  });

  it("空模式列表", () => {
    expect(matchModel("gpt-4o", [])).toBe(false);
  });

  it("大小写不敏感", () => {
    expect(matchModel("GPT-4o", ["gpt-*"])).toBe(true);
    expect(matchModel("Claude-3-Opus", ["claude-*"])).toBe(true);
  });

  it("特殊正则字符不被误解析", () => {
    expect(matchModel("model+v1.0", ["model+v1.0"])).toBe(true);
    expect(matchModel("model(v1)", ["model(v1)"])).toBe(true);
    expect(matchModel("model[1]", ["model[1]"])).toBe(true);
  });
});

describe("getApplicableTemplates", () => {
  const templates: RequestTemplate[] = [
    { id: "1", name: "t1", description: "", models: ["gpt-*"], mergeBody: { temperature: 0.5 }, enabled: true },
    { id: "2", name: "t2", description: "", models: ["*"], mergeBody: { top_p: 0.9 }, enabled: true },
    { id: "3", name: "t3", description: "", models: ["claude-*"], mergeBody: { max_tokens: 1000 }, enabled: false },
    { id: "4", name: "t4", description: "", models: ["qwen-*"], mergeBody: { enable_thinking: true }, enabled: true },
  ];

  it("匹配 gpt-4o 返回 t1 和 t2（t3 禁用不返回）", () => {
    const result = getApplicableTemplates(templates, "gpt-4o");
    expect(result.map((t) => t.id)).toEqual(["1", "2"]);
  });

  it("匹配 claude-3-opus 只返回 t2（t3 禁用）", () => {
    const result = getApplicableTemplates(templates, "claude-3-opus");
    expect(result.map((t) => t.id)).toEqual(["2"]);
  });

  it("匹配 qwen-turbo 返回 t2 和 t4", () => {
    const result = getApplicableTemplates(templates, "qwen-turbo");
    expect(result.map((t) => t.id)).toEqual(["2", "4"]);
  });

  it("无匹配时返回空数组", () => {
    const templatesNoWildcard: RequestTemplate[] = [
      { id: "1", name: "t1", description: "", models: ["gpt-*"], mergeBody: {}, enabled: true },
      { id: "2", name: "t2", description: "", models: ["claude-*"], mergeBody: {}, enabled: true },
    ];
    const result = getApplicableTemplates(templatesNoWildcard, "gemini-pro");
    expect(result).toEqual([]);
  });
});

describe("applyTemplates", () => {
  it("无模板时原样返回", () => {
    const body = { model: "gpt-4o", messages: [] };
    expect(applyTemplates(body, [])).toEqual(body);
  });

  it("单模板深度合并", () => {
    const body = { model: "gpt-4o", messages: [] };
    const templates: RequestTemplate[] = [
      { id: "1", name: "t1", description: "", models: ["*"], mergeBody: { temperature: 0.5 }, enabled: true },
    ];
    const result = applyTemplates(body, templates);
    expect(result).toEqual({ model: "gpt-4o", messages: [], temperature: 0.5 });
  });

  it("多模板依次合并", () => {
    const body = { model: "gpt-4o", messages: [] };
    const templates: RequestTemplate[] = [
      { id: "1", name: "t1", description: "", models: ["*"], mergeBody: { temperature: 0.5 }, enabled: true },
      { id: "2", name: "t2", description: "", models: ["*"], mergeBody: { top_p: 0.9 }, enabled: true },
    ];
    const result = applyTemplates(body, templates);
    expect(result).toEqual({ model: "gpt-4o", messages: [], temperature: 0.5, top_p: 0.9 });
  });

  it("嵌套对象深度合并", () => {
    const body = { model: "gpt-4o", extra_body: { option_a: 1 } };
    const templates: RequestTemplate[] = [
      { id: "1", name: "t1", description: "", models: ["*"], mergeBody: { extra_body: { option_b: 2 } }, enabled: true },
    ];
    const result = applyTemplates(body, templates);
    expect(result).toEqual({ model: "gpt-4o", extra_body: { option_a: 1, option_b: 2 } });
  });

  it("数组整体替换", () => {
    const body = { model: "gpt-4o", stop: ["a"] };
    const templates: RequestTemplate[] = [
      { id: "1", name: "t1", description: "", models: ["*"], mergeBody: { stop: ["b", "c"] }, enabled: true },
    ];
    const result = applyTemplates(body, templates);
    expect(result).toEqual({ model: "gpt-4o", stop: ["b", "c"] });
  });

  it("后模板覆盖前模板的同名字段", () => {
    const body = { model: "gpt-4o" };
    const templates: RequestTemplate[] = [
      { id: "1", name: "t1", description: "", models: ["*"], mergeBody: { temperature: 0.5 }, enabled: true },
      { id: "2", name: "t2", description: "", models: ["*"], mergeBody: { temperature: 1.0 }, enabled: true },
    ];
    const result = applyTemplates(body, templates);
    expect(result.temperature).toBe(1.0);
  });
});
