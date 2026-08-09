/**
 * 登录限流客户端 IP 解析（pages/api/admin/auth.ts getClientIp）单元测试
 *
 * 覆盖可信代理链：EdgeOne 部署（DEPLOY_PLATFORM=edgeone）采信 EO-Client-IP /
 * EO-Connecting-IP / XFF 首项、其他部署平台（docker/cf/未设置）忽略伪造 EO 头、
 * 边缘运行时（无 socket）采信 CF-Connecting-IP、有 socket 时忽略伪造的
 * CF-Connecting-IP、直连忽略伪造 XFF、可信代理链从右向左取首个非可信条目、
 * 全可信链回退 X-Real-IP、无 socket 地址且无边缘注入头时返回 null
 * （不归入共享桶）。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

function setDeployPlatform(value: string | undefined): void {
  if (value === undefined) delete process.env.DEPLOY_PLATFORM;
  else process.env.DEPLOY_PLATFORM = value;
}

afterEach(() => {
  setTrustedProxies(undefined);
  setDeployPlatform(undefined);
});

describe("getClientIp — EdgeOne 部署（DEPLOY_PLATFORM=edgeone）", () => {
  beforeEach(() => setDeployPlatform("edgeone"));

  it("采信 EO-Client-IP（优先于 socket 对端与 XFF）", () => {
    const req = makeReq({
      headers: { "eo-client-ip": "5.6.7.8", "x-forwarded-for": "9.9.9.9" },
      socket: { remoteAddress: "43.168.0.1" },
    });
    expect(getClientIp(asReq(req))).toBe("5.6.7.8");
  });

  it("无 EO-Client-IP 时采信 EO-Connecting-IP", () => {
    const req = makeReq({
      headers: { "eo-connecting-ip": "6.6.6.6" },
      socket: { remoteAddress: "43.168.0.1" },
    });
    expect(getClientIp(asReq(req))).toBe("6.6.6.6");
  });

  it("EO-Client-IP 优先于 EO-Connecting-IP", () => {
    const req = makeReq({
      headers: { "eo-client-ip": "5.5.5.5", "eo-connecting-ip": "6.6.6.6" },
    });
    expect(getClientIp(asReq(req))).toBe("5.5.5.5");
  });

  it("无 EO 专属头时回退 XFF 首项（EO 维护，首项为客户端真实 IP）", () => {
    const req = makeReq({
      headers: { "x-forwarded-for": "5.6.7.8, 43.168.0.1" },
      socket: { remoteAddress: "43.168.0.1" },
    });
    expect(getClientIp(asReq(req))).toBe("5.6.7.8");
  });

  it("EO 头 IPv4-mapped 形态归一化为点分十进制", () => {
    const req = makeReq({ headers: { "eo-client-ip": "::ffff:5.6.7.8" } });
    expect(getClientIp(asReq(req))).toBe("5.6.7.8");
  });

  it("无 EO 头且无 XFF 时回退 socket 对端（边缘节点 IP，保持现状语义）", () => {
    const req = makeReq({ socket: { remoteAddress: "43.168.0.1" } });
    expect(getClientIp(asReq(req))).toBe("43.168.0.1");
  });

  it("畸形 XFF（前导逗号）不返回空串——回退 socket 对端而非 fail-open", () => {
    const req = makeReq({
      headers: { "x-forwarded-for": ", 5.6.7.8" },
      socket: { remoteAddress: "43.168.0.1" },
    });
    expect(getClientIp(asReq(req))).toBe("43.168.0.1");
  });

  it("EO 专属头缺失时不落入 CF-Connecting-IP 信任分支（EO 不注入该头）", () => {
    const req = makeReq({
      headers: { "cf-connecting-ip": "5.6.7.8" },
      socket: { remoteAddress: "43.168.0.1" },
    });
    expect(getClientIp(asReq(req))).toBe("43.168.0.1");
  });
});

describe("getClientIp — 非 EO 部署忽略伪造 EO 头", () => {
  it("Docker 部署（DEPLOY_PLATFORM=docker）：忽略 EO 头，使用 TCP 对端", () => {
    setDeployPlatform("docker");
    const req = makeReq({
      headers: { "eo-client-ip": "5.6.7.8", "eo-connecting-ip": "6.6.6.6" },
    });
    expect(getClientIp(asReq(req))).toBe("1.2.3.4");
  });

  it("CF 部署（DEPLOY_PLATFORM=cf）：忽略 EO 头，使用 TCP 对端", () => {
    setDeployPlatform("cf");
    const req = makeReq({ headers: { "eo-client-ip": "5.6.7.8" } });
    expect(getClientIp(asReq(req))).toBe("1.2.3.4");
  });

  it("未设置 DEPLOY_PLATFORM（直连/本地）：忽略 EO 头，使用 TCP 对端", () => {
    const req = makeReq({
      headers: { "eo-client-ip": "5.6.7.8", "eo-connecting-ip": "6.6.6.6" },
    });
    expect(getClientIp(asReq(req))).toBe("1.2.3.4");
  });

  it("Docker 部署下伪造 XFF 同样被忽略", () => {
    setDeployPlatform("docker");
    const req = makeReq({ headers: { "x-forwarded-for": "8.8.8.8" } });
    expect(getClientIp(asReq(req))).toBe("1.2.3.4");
  });
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
