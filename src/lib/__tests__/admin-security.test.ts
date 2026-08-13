/**
 * 共享安全工具（src/lib/admin-security.ts）单元测试
 *
 * 覆盖 isSafeUrl 的 DNS 第二层：公网解析放行、内网/AAAA-only 解析拦截、
 * 域名无法解析 fail-closed、IP 字面量跳过 DNS 层。
 * node:dns 被 mock（顶层 vi.mock），保证测试确定性、不依赖网络。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { checkCsrfOrigin, isSafeUrl } from "../admin-security";

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

// ==================== checkCsrfOrigin — CSRF Origin/Referer 校验 ====================

describe("checkCsrfOrigin — 同源校验", () => {
  let statusCode: number;
  let body: unknown;

  function makeReq(overrides: Record<string, unknown> = {}): any {
    return { method: "POST", headers: { host: "example.com" }, ...overrides };
  }

  function makeRes(): any {
    statusCode = 200;
    body = undefined;
    const res: any = {
      status(c: number) {
        statusCode = c;
        return res;
      },
      json(b: unknown) {
        body = b;
        return res;
      },
    };
    return res;
  }

  beforeEach(() => {
    delete process.env.ENVIRONMENT;
  });

  afterEach(() => {
    delete process.env.ENVIRONMENT;
  });

  it("同源 Origin 放行", () => {
    const res = makeRes();
    const ok = checkCsrfOrigin(
      makeReq({ headers: { host: "example.com", origin: "https://example.com" } }),
      res
    );
    expect(ok).toBe(true);
    expect(statusCode).toBe(200);
  });

  it("同源 Origin（带端口）放行", () => {
    const res = makeRes();
    const ok = checkCsrfOrigin(
      makeReq({ headers: { host: "example.com:3000", origin: "http://example.com:3000" } }),
      res
    );
    expect(ok).toBe(true);
  });

  it("跨源 Origin 拒绝 403", () => {
    const res = makeRes();
    const ok = checkCsrfOrigin(
      makeReq({ headers: { host: "example.com", origin: "https://evil.example" } }),
      res
    );
    expect(ok).toBe(false);
    expect(statusCode).toBe(403);
    expect(body).toEqual({ success: false, error: "请求来源不合法" });
  });

  it("同源 Referer 放行", () => {
    const res = makeRes();
    const ok = checkCsrfOrigin(
      makeReq({ headers: { host: "example.com", referer: "https://example.com/admin" } }),
      res
    );
    expect(ok).toBe(true);
  });

  it("跨源 Referer 拒绝 403", () => {
    const res = makeRes();
    const ok = checkCsrfOrigin(
      makeReq({ headers: { host: "example.com", referer: "https://evil.example/login" } }),
      res
    );
    expect(ok).toBe(false);
    expect(statusCode).toBe(403);
  });

  it("畸形 Origin（null / 不可解析 URL）fail-closed 拒绝", () => {
    const res = makeRes();
    const ok = checkCsrfOrigin(
      makeReq({ headers: { host: "example.com", origin: "null" } }),
      res
    );
    expect(ok).toBe(false);
    expect(statusCode).toBe(403);
  });

  it("畸形 Referer（不可解析 URL）fail-closed 拒绝", () => {
    const res = makeRes();
    const ok = checkCsrfOrigin(
      makeReq({ headers: { host: "example.com", referer: "not-a-url" } }),
      res
    );
    expect(ok).toBe(false);
    expect(statusCode).toBe(403);
  });
});

describe("checkCsrfOrigin — 无来源标识与本地开发", () => {
  let statusCode: number;
  let body: unknown;

  function makeReq(overrides: Record<string, unknown> = {}): any {
    return { method: "POST", headers: { host: "example.com" }, ...overrides };
  }

  function makeRes(): any {
    statusCode = 200;
    body = undefined;
    const res: any = {
      status(c: number) {
        statusCode = c;
        return res;
      },
      json(b: unknown) {
        body = b;
        return res;
      },
    };
    return res;
  }

  beforeEach(() => {
    delete process.env.ENVIRONMENT;
  });

  afterEach(() => {
    delete process.env.ENVIRONMENT;
  });

  it("非生产环境：无 Origin 且无 Referer 放行（本地 curl 等工具）", () => {
    const res = makeRes();
    const ok = checkCsrfOrigin(makeReq(), res);
    expect(ok).toBe(true);
  });

  it("生产环境：POST 无来源标识拒绝 403", () => {
    process.env.ENVIRONMENT = "production";
    const res = makeRes();
    const ok = checkCsrfOrigin(makeReq(), res);
    expect(ok).toBe(false);
    expect(statusCode).toBe(403);
    expect(body).toEqual({ success: false, error: "请求缺少来源标识" });
  });

  it("生产环境：GET 无来源标识放行（不拦截读操作）", () => {
    process.env.ENVIRONMENT = "production";
    const res = makeRes();
    const ok = checkCsrfOrigin(makeReq({ method: "GET" }), res);
    expect(ok).toBe(true);
  });

  it("非生产环境：localhost Origin 且请求 host 为 localhost 放行", () => {
    const res = makeRes();
    const ok = checkCsrfOrigin(
      makeReq({ headers: { host: "localhost:3000", origin: "http://localhost:3000" } }),
      res
    );
    expect(ok).toBe(true);
  });

  it("非生产环境：localhost Origin 但请求 host 非 localhost 拒绝", () => {
    const res = makeRes();
    const ok = checkCsrfOrigin(
      makeReq({ headers: { host: "example.com", origin: "http://localhost:3000" } }),
      res
    );
    expect(ok).toBe(false);
    expect(statusCode).toBe(403);
  });

  it("非生产环境：来源与 host 均为 localhost（端口不同）放行（本地开发绕过）", () => {
    const res = makeRes();
    const ok = checkCsrfOrigin(
      makeReq({ headers: { host: "localhost", origin: "http://localhost:3000" } }),
      res
    );
    // sourceHost=localhost:3000 ≠ reqHost=localhost，但非生产环境下 localhost 双端豁免
    expect(ok).toBe(true);
  });

  it("生产环境：localhost 来源不允许绕过（localhost Origin + 非 localhost host 拒绝）", () => {
    process.env.ENVIRONMENT = "production";
    const res = makeRes();
    const ok = checkCsrfOrigin(
      makeReq({ headers: { host: "example.com", origin: "http://localhost:3000" } }),
      res
    );
    // 生产环境下 localhostAllowed 关闭，localhost 来源不再豁免
    expect(ok).toBe(false);
    expect(statusCode).toBe(403);
  });
});
