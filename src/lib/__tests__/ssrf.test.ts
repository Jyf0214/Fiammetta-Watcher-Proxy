/**
 * SSRF 防护共享模块（src/lib/ssrf.ts）单元测试
 *
 * 覆盖：IPv4 内网段、IPv6 回环/ULA/链路本地（fe80::/10 全范围）、
 * IPv4-mapped IPv6 的点分十进制与 URL 规范化的十六进制形态、URL 协议白名单。
 */

import { describe, it, expect } from "vitest";
import { isPrivateIp, isSafeUpstreamUrl } from "../ssrf";

// ==================== isPrivateIp ====================

describe("isPrivateIp", () => {
  it.each([
    // IPv4 内网段
    ["10.0.0.1", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["172.32.0.1", false],
    ["192.168.1.1", true],
    ["169.254.169.254", true],
    ["127.0.0.1", true],
    ["0.0.0.0", true],
    ["8.8.8.8", false],
    ["9.9.9.9", false],
    // IPv6 回环 / 未指定
    ["::1", true],
    ["::", true],
    // IPv6 ULA（fc00::/7）
    ["fc00::1", true],
    ["fd00::1", true],
    // IPv6 链路本地（fe80::/10，覆盖 fe80-febf）
    ["fe80::1", true],
    ["fe89::1", true],
    ["fe9a::1", true],
    ["feab::1", true],
    ["febf::1", true],
    ["fec0::1", false],
    ["2001:db8::1", false],
    // IPv4-mapped IPv6 — 点分十进制
    ["::ffff:127.0.0.1", true],
    ["::ffff:169.254.169.254", true],
    ["::ffff:8.8.8.8", false],
    // IPv4-mapped IPv6 — URL 规范化十六进制（new URL 会把 ::ffff:127.0.0.1 变为 ::ffff:7f00:1）
    ["::ffff:7f00:1", true],
    ["::ffff:0a000001", true],
    ["::ffff:c0a8:28", true],
    ["::ffff:a9fe:a9fe", true],
    ["::ffff:0808:0808", false],
    // 带方括号（URL.hostname 形态）
    ["[::ffff:127.0.0.1]", true],
    ["[::1]", true],
  ])("判定 %s → %s", (input, expected) => {
    expect(isPrivateIp(input)).toBe(expected);
  });
});

// ==================== isSafeUpstreamUrl ====================

describe("isSafeUpstreamUrl", () => {
  it("拒绝内网 IP 字面量（含 IPv6 变体与 URL 规范化形态）", () => {
    for (const url of [
      "http://127.0.0.1:3000",
      "http://[::ffff:127.0.0.1]:3000",
      "http://[::ffff:7f00:1]:3000",
      "http://localhost:3000",
      "http://[::1]:3000",
      "http://[fd00::1]:3000",
      "http://10.0.0.5",
      "http://0.0.0.0",
    ]) {
      expect(isSafeUpstreamUrl(url).safe).toBe(false);
    }
  });

  it("放行公网 URL", () => {
    expect(isSafeUpstreamUrl("https://api.openai.com").safe).toBe(true);
    expect(isSafeUpstreamUrl("http://example.com/v1").safe).toBe(true);
  });

  it("拒绝非 http/https 协议与畸形 URL", () => {
    expect(isSafeUpstreamUrl("file:///etc/passwd").safe).toBe(false);
    expect(isSafeUpstreamUrl("ftp://example.com").safe).toBe(false);
    expect(isSafeUpstreamUrl("not-a-url").safe).toBe(false);
  });
});