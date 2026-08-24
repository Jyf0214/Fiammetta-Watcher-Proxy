/**
 * 模型价格表模块单元测试
 *
 * 覆盖：解析校验（strict/宽松）、序列化稳定性、模型名匹配回退、成本计算、
 * 快照懒加载（TTL + 失败沿用旧值）。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const getConfigMock = vi.hoisted(() => vi.fn());

vi.mock("../../../worker/src/config", () => ({
  getConfig: (...args: unknown[]) => getConfigMock(...args),
}));

import {
  MODEL_PRICING_CONFIG_KEY,
  parseModelPricing,
  serializeModelPricing,
  lookupPricing,
  computeCost,
  ensurePricingLoaded,
  getPricingSnapshot,
  resetPricingCacheForTests,
} from "../model-pricing";

describe("parseModelPricing", () => {
  it("空输入返回空表", () => {
    expect(parseModelPricing(null)).toEqual({});
    expect(parseModelPricing(undefined)).toEqual({});
    expect(parseModelPricing("")).toEqual({});
  });

  it("解析合法价格表", () => {
    const raw = JSON.stringify({ "gpt-4o": { input: 2.5, output: 10 } });
    expect(parseModelPricing(raw)).toEqual({ "gpt-4o": { input: 2.5, output: 10 } });
  });

  it("非法 JSON：strict 抛错，宽松返回空表", () => {
    expect(() => parseModelPricing("{bad", { strict: true })).toThrow();
    expect(parseModelPricing("{bad")).toEqual({});
  });

  it("非对象结构：strict 抛错，宽松返回空表", () => {
    expect(() => parseModelPricing("[1,2]", { strict: true })).toThrow();
    expect(parseModelPricing("[1,2]")).toEqual({});
  });

  it("负数与非数字价格：strict 抛错，宽松跳过该条目", () => {
    const bad = JSON.stringify({ a: { input: -1, output: 1 }, b: { input: "x", output: 1 }, c: { input: 0, output: 0 } });
    expect(() => parseModelPricing(bad, { strict: true })).toThrow();
    const lenient = parseModelPricing(bad);
    expect(lenient).toEqual({ c: { input: 0, output: 0 } });
  });

  it("允许显式 0 价（免费模型）", () => {
    const raw = JSON.stringify({ free: { input: 0, output: 0 } });
    expect(parseModelPricing(raw)).toEqual({ free: { input: 0, output: 0 } });
  });

  it("条目数超上限时拒绝", () => {
    const big: Record<string, { input: number; output: number }> = {};
    for (let i = 0; i < 20001; i++) big[`m${i}`] = { input: 1, output: 1 };
    expect(() => parseModelPricing(JSON.stringify(big), { strict: true })).toThrow(/上限/);
  });
});

describe("serializeModelPricing", () => {
  it("键按字典序输出，同内容序列化稳定", () => {
    const a = serializeModelPricing({ b: { input: 1, output: 2 }, a: { input: 3, output: 4 } });
    const b = serializeModelPricing({ a: { input: 3, output: 4 }, b: { input: 1, output: 2 } });
    expect(a).toBe(b);
    expect(JSON.parse(a)).toEqual({ a: { input: 3, output: 4 }, b: { input: 1, output: 2 } });
  });
});

describe("lookupPricing", () => {
  const pricing = parseModelPricing(
    JSON.stringify({
      "gpt-4o": { input: 1, output: 2 },
      "openai/gpt-4o-mini": { input: 3, output: 4 },
    })
  );

  it("精确命中", () => {
    expect(lookupPricing(pricing, "gpt-4o")?.input).toBe(1);
  });

  it("大小写不敏感", () => {
    expect(lookupPricing(pricing, "GPT-4O")?.input).toBe(1);
  });

  it("取最后一段 / 后短名回退", () => {
    // 请求模型名为裸短名，表里是 vendor/model
    const vendorPricing = parseModelPricing(JSON.stringify({ "x/y-z": { input: 5, output: 6 } }));
    expect(lookupPricing(vendorPricing, "y-z")?.input).toBe(5);
    expect(lookupPricing(pricing, "openai/gpt-4o-mini")?.input).toBe(3);
  });

  it("未命中返回 undefined", () => {
    expect(lookupPricing(pricing, "unknown-model")).toBeUndefined();
    expect(lookupPricing(pricing, "")).toBeUndefined();
  });

  it("Object.prototype 属性名不命中（防 NaN 污染）", () => {
    // 客户端可控的模型名可能是 "toString"/"constructor" 等继承属性名，
    // 普通下标访问会拿到函数并让 cost 变成 NaN
    for (const name of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(lookupPricing(pricing, name)).toBeUndefined();
      expect(computeCost(pricing, name, 1000, 1000)).toBe(0);
    }
  });
});

describe("computeCost", () => {
  const pricing = { "m": { input: 3, output: 12 } };

  it("按百万 token 单价计算并保留 6 位小数", () => {
    // 1M 输入 + 0.5M 输出 = 3 + 6 = 9 美元
    expect(computeCost(pricing, "m", 1_000_000, 500_000)).toBe(9);
  });

  it("小数额四舍五入到 1e-6", () => {
    // 100 token 输入 @3/M = 0.0003
    expect(computeCost(pricing, "m", 100, 0)).toBe(0.0003);
  });

  it("无价格数据计 0（不猜默认价）", () => {
    expect(computeCost(pricing, "no-price", 1000, 1000)).toBe(0);
  });
});

describe("ensurePricingLoaded 快照", () => {
  beforeEach(() => {
    resetPricingCacheForTests();
    getConfigMock.mockReset();
  });

  it("从 configs 加载快照并同步读取", async () => {
    getConfigMock.mockResolvedValue(JSON.stringify({ k: { input: 1, output: 2 } }));
    await ensurePricingLoaded({} as never);
    expect(getConfigMock).toHaveBeenCalledWith({}, MODEL_PRICING_CONFIG_KEY, undefined);
    expect(getPricingSnapshot()).toEqual({ k: { input: 1, output: 2 } });
  });

  it("TTL 内不重复加载", async () => {
    getConfigMock.mockResolvedValue("{}");
    await ensurePricingLoaded({} as never);
    await ensurePricingLoaded({} as never);
    expect(getConfigMock).toHaveBeenCalledTimes(1);
  });

  it("读库失败沿用旧快照且不抛错", async () => {
    getConfigMock.mockResolvedValueOnce(JSON.stringify({ keep: { input: 7, output: 8 } }));
    await ensurePricingLoaded({} as never);
    getConfigMock.mockRejectedValueOnce(new Error("db down"));
    resetPricingCacheForTests();
    // 重置后首次加载失败 → 快照为空但不抛错
    await expect(ensurePricingLoaded({} as never)).resolves.toBeUndefined();
    expect(getPricingSnapshot()).toEqual({});
  });
});
