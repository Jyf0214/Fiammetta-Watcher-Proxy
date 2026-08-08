/**
 * 共享安全工具（src/lib/admin-security.ts）单元测试
 *
 * 覆盖 isSafeUrl 的 DNS 第二层：公网解析放行、内网/AAAA-only 解析拦截、
 * 域名无法解析 fail-closed、IP 字面量跳过 DNS 层。
 * node:dns 被 mock（顶层 vi.mock），保证测试确定性、不依赖网络。
 */

import { describe, expect, it, vi } from "vitest";

// vi.hoisted + 类型化 vi.fn：mock 引用可被 vi.mock 工厂使用（hoisting），
// resolve4/resolve6 保留精确签名 (hostname: string) => Promise<string[]>
const { resolve4, resolve6 } = vi.hoisted(() => ({
  resolve4: vi.fn<(hostname: string) => Promise<string[]>>(),
  resolve6: vi.fn<(hostname: string) => Promise<string[]>>(),
}));

vi.mock("node:dns", () => ({
  // vitest 要求 mock 工厂返回带 default 导出（ESM interop 校验）
  default: { promises: { resolve4, resolve6 } },
}));

import { isSafeUrl } from "../admin-security";

function mockResolve(v4: string[], v6: string[]): void {
  resolve4.mockResolvedValue(v4);
  resolve6.mockResolvedValue(v6);
}

describe("isSafeUrl — DNS 第二层", () => {
  it("域名解析到公网地址时放行", async () => {
    mockResolve(["93.184.216.34"], []);
    await expect(isSafeUrl("https://example.com")).resolves.toMatchObject({ safe: true });
  });

  it("域名解析到内网 IPv4 时拒绝", async () => {
    mockResolve(["127.0.0.1"], []);
    await expect(isSafeUrl("https://localtest.me")).resolves.toMatchObject({
      safe: false,
      reason: expect.stringContaining("内网地址"),
    });
  });

  it("AAAA-only 内网域名（IPv6 ULA）时拒绝", async () => {
    mockResolve([], ["fd00::1"]);
    await expect(isSafeUrl("https://aaaa-only.example")).resolves.toMatchObject({
      safe: false,
      reason: expect.stringContaining("内网地址"),
    });
  });

  it("域名无法解析（A/AAAA 均为空）时 fail-closed 拒绝", async () => {
    mockResolve([], []);
    await expect(isSafeUrl("https://nxdomain.invalid")).resolves.toMatchObject({
      safe: false,
      reason: expect.stringContaining("无法解析"),
    });
  });

  it("resolve4 抛错但 resolve6 有公网结果时放行", async () => {
    resolve4.mockRejectedValue(new Error("dns error"));
    resolve6.mockResolvedValue(["2606:2800:220:1:248:1893:25c8:1946"]);
    await expect(isSafeUrl("https://example.com")).resolves.toMatchObject({ safe: true });
  });
});

describe("isSafeUrl — IP 字面量跳过 DNS 层", () => {
  it("公网 IP 字面量直接放行，不触发 DNS 解析", async () => {
    resolve4.mockClear();
    resolve6.mockClear();
    await expect(isSafeUrl("https://8.8.8.8")).resolves.toMatchObject({ safe: true });
    expect(resolve4).not.toHaveBeenCalled();
    expect(resolve6).not.toHaveBeenCalled();
  });

  it("公网 IPv6 字面量直接放行，不触发 DNS 解析", async () => {
    resolve4.mockClear();
    resolve6.mockClear();
    await expect(isSafeUrl("https://[2606:2800:220:1:248:1893:25c8:1946]")).resolves.toMatchObject({
      safe: true,
    });
    expect(resolve4).not.toHaveBeenCalled();
  });
});

describe("isSafeUrl — 第一层拦截（不触发 DNS）", () => {
  it("内网 IP 字面量在第一层即拒绝", async () => {
    await expect(isSafeUrl("http://169.254.169.254/latest/meta-data")).resolves.toMatchObject({
      safe: false,
    });
    await expect(isSafeUrl("http://[fd00::1]:3000")).resolves.toMatchObject({ safe: false });
  });

  it("localhost 域名在第一层即拒绝", async () => {
    await expect(isSafeUrl("http://localhost:3000")).resolves.toMatchObject({ safe: false });
  });
});
