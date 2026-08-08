/**
 * 登录限流客户端 IP 解析（pages/api/admin/auth.ts getClientIp）单元测试
 *
 * 覆盖可信代理链：边缘运行时（无 socket）采信 CF-Connecting-IP、
 * 有 socket 时忽略伪造的 CF-Connecting-IP、直连忽略伪造 XFF、
 * 可信代理链从右向左取首个非可信条目、全可信链回退 X-Real-IP、
 * 无 socket 地址且无边缘注入头时返回 null（不归入共享桶）。
 */

import { afterEach, describe, expect, it } from "vitest";
import type { NextApiRequest } from "next";
import { getClientIp } from "../../../pages/api/admin/auth";

interface ReqLike {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}

function makeReq(overrides: Partial<ReqLike> = {}): ReqLike {
  return { headers: {}, socket: { remoteAddress: "1.2.3.4" }, ...overrides };
}

/** 最小可迭代 NextApiRequest 模拟（getClientIp 仅读取 headers/socket.remoteAddress） */
function asReq(req: ReqLike): NextApiRequest {
  return req as unknown as NextApiRequest;
}

function setTrustedProxies(value: string | undefined): void {
  if (value === undefined) delete process.env.TRUSTED_PROXY_IPS;
  else process.env.TRUSTED_PROXY_IPS = value;
}

afterEach(() => {
  setTrustedProxies(undefined);
});

describe("getClientIp — 边缘运行时（无 TCP 对端）", () => {
  it("无 socket 地址时采信边缘注入的 CF-Connecting-IP", () => {
    const req = makeReq({
      headers: { "cf-connecting-ip": "5.6.7.8" },
      socket: {},
    });
    expect(getClientIp(asReq(req))).toBe("5.6.7.8");
  });

  it("CF-Connecting-IP 的 IPv4-mapped 形态归一化为点分十进制", () => {
    const req = makeReq({
      headers: { "cf-connecting-ip": "::ffff:5.6.7.8" },
      socket: {},
    });
    expect(getClientIp(asReq(req))).toBe("5.6.7.8");
  });

  it("remoteAddress 为空字符串（适配层形态）时同样走边缘分支", () => {
    const req = makeReq({
      headers: { "cf-connecting-ip": "5.6.7.8" },
      socket: { remoteAddress: "" },
    });
    expect(getClientIp(asReq(req))).toBe("5.6.7.8");
  });

  it("有 socket 地址时忽略伪造的 CF-Connecting-IP（攻击者可任意伪造该头）", () => {
    const req = makeReq({ headers: { "cf-connecting-ip": "5.6.7.8" } });
    expect(getClientIp(asReq(req))).toBe("1.2.3.4");
  });

  it("配置了 TRUSTED_PROXY_IPS 且对端可信时仍忽略 CF-Connecting-IP（非 CF 链路不会覆盖该头，返回 null 而非伪造值）", () => {
    setTrustedProxies("10.0.0.1");
    const req = makeReq({
      headers: { "cf-connecting-ip": "5.6.7.8" },
      socket: { remoteAddress: "10.0.0.1" },
    });
    expect(getClientIp(asReq(req))).toBeNull();
  });
});

describe("getClientIp — 直连（对端不可信）", () => {
  it("忽略攻击者伪造的 X-Forwarded-For，使用 TCP 对端地址", () => {
    const req = makeReq({ headers: { "x-forwarded-for": "8.8.8.8" } });
    expect(getClientIp(asReq(req))).toBe("1.2.3.4");
  });

  it("配置了 TRUSTED_PROXY_IPS 但对端不在列表内 → XFF 仍不可信", () => {
    setTrustedProxies("10.0.0.1");
    const req = makeReq({ headers: { "x-forwarded-for": "8.8.8.8, 10.0.0.1" } });
    expect(getClientIp(asReq(req))).toBe("1.2.3.4");
  });

  it("忽略伪造的 X-Real-IP", () => {
    const req = makeReq({ headers: { "x-real-ip": "8.8.8.8" } });
    expect(getClientIp(asReq(req))).toBe("1.2.3.4");
  });
});

describe("getClientIp — 经可信代理", () => {
  it("从右向左跳过可信代理，取首个非可信条目", () => {
    setTrustedProxies("10.0.0.1");
    const req = makeReq({
      headers: { "x-forwarded-for": "6.6.6.6, 10.0.0.1" },
      socket: { remoteAddress: "10.0.0.1" },
    });
    expect(getClientIp(asReq(req))).toBe("6.6.6.6");
  });

  it("多层可信代理链同样从右向左解析", () => {
    setTrustedProxies("10.0.0.1, 10.0.0.2");
    const req = makeReq({
      headers: { "x-forwarded-for": "5.6.7.8, 10.0.0.1, 10.0.0.2" },
      socket: { remoteAddress: "10.0.0.2" },
    });
    expect(getClientIp(asReq(req))).toBe("5.6.7.8");
  });

  it("链全为可信条目时回退 X-Real-IP", () => {
    setTrustedProxies("10.0.0.1");
    const req = makeReq({
      headers: { "x-forwarded-for": "10.0.0.1", "x-real-ip": "5.6.7.8" },
      socket: { remoteAddress: "10.0.0.1" },
    });
    expect(getClientIp(asReq(req))).toBe("5.6.7.8");
  });

  it("链全为可信条目且无 X-Real-IP 时返回 null（不归入共享桶）", () => {
    setTrustedProxies("10.0.0.1");
    const req = makeReq({
      headers: { "x-forwarded-for": "10.0.0.1" },
      socket: { remoteAddress: "10.0.0.1" },
    });
    expect(getClientIp(asReq(req))).toBeNull();
  });
});

describe("getClientIp — 极端环境", () => {
  it("无 socket 地址且无边缘注入头时返回 null（调用方限流 fail-open）", () => {
    const req = makeReq({ socket: {} });
    expect(getClientIp(asReq(req))).toBeNull();
  });
});
