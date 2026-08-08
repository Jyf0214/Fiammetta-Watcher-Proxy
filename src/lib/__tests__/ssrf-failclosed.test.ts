/**
 * isSafeUrl fail-closed 降级测试
 *
 * node:dns 不可用（无 nodejs_compat 的 workerd / 降级运行时）或
 * promises API 不完整时，域名型 URL 必须被拒绝（fail-closed），
 * 绝不静默放行；IP 字面量不受影响（第一层已校验）。
 *
 * 使用 vi.doMock + vi.resetModules 逐例模拟 node:dns 的不同故障形态。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

describe("isSafeUrl — node:dns 不可用", () => {
  it("import node:dns 抛错 → 拒绝域名型 URL", async () => {
    vi.doMock("node:dns", () => {
      throw new Error("module not found");
    });
    const { isSafeUrl } = await import("../admin-security");
    await expect(isSafeUrl("https://example.com")).resolves.toMatchObject({
      safe: false,
      reason: expect.stringContaining("DNS 解析能力不可用"),
    });
  });

  it("import node:dns 抛错 → IP 字面量仍可放行（第一层已校验）", async () => {
    vi.doMock("node:dns", () => {
      throw new Error("module not found");
    });
    const { isSafeUrl } = await import("../admin-security");
    await expect(isSafeUrl("https://8.8.8.8")).resolves.toMatchObject({ safe: true });
    await expect(isSafeUrl("http://169.254.169.254")).resolves.toMatchObject({ safe: false });
  });

  it("promises API 缺失 → 拒绝域名型 URL", async () => {
    // 显式声明 promises: undefined（键存在）：vitest 的 mock 代理只在访问
    // 完全缺失的导出键时抛错，undefined 值可正常通过并触发 fail-closed
    vi.doMock("node:dns", () => ({ default: {}, promises: undefined }));
    const { isSafeUrl } = await import("../admin-security");
    await expect(isSafeUrl("https://example.com")).resolves.toMatchObject({
      safe: false,
      reason: expect.stringContaining("DNS 解析能力不可用"),
    });
  });

  it("缺少 resolve6（resolve4 存在）→ 拒绝域名型 URL", async () => {
    vi.doMock("node:dns", () => ({
      default: { promises: { resolve4: vi.fn() } },
    }));
    const { isSafeUrl } = await import("../admin-security");
    await expect(isSafeUrl("https://example.com")).resolves.toMatchObject({
      safe: false,
      reason: expect.stringContaining("DNS 解析能力不可用"),
    });
  });

  it("default 导出形态（ESM interop）下 promises 正常可用", async () => {
    vi.doMock("node:dns", () => ({
      default: {
        promises: {
          resolve4: vi.fn().mockResolvedValue(["93.184.216.34"]),
          resolve6: vi.fn().mockResolvedValue([]),
        },
      },
    }));
    const { isSafeUrl } = await import("../admin-security");
    await expect(isSafeUrl("https://example.com")).resolves.toMatchObject({ safe: true });
  });
});
