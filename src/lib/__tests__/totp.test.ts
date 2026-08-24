/**
 * TOTP 模块单元测试
 *
 * 使用 RFC 6238 附录 B 的 SHA-1 标准测试向量（8 位码取自文档；
 * 本实现输出 6 位，即标准 8 位向量的后 6 位——与 Google Authenticator
 * 默认行为一致）。
 */

import { describe, it, expect, vi } from "vitest";

import {
  base32Encode,
  base32Decode,
  hotp,
  verifyTotp,
  generateTotpSecret,
  buildOtpauthUri,
} from "../totp";

// RFC 6238 B 节：secret = "12345678901234567890"（ASCII），SHA1
const RFC_SECRET_ASCII = "12345678901234567890";
const RFC_SECRET_B32 = base32Encode(new TextEncoder().encode(RFC_SECRET_ASCII));

/** 直接以固定 counter 计算 HOTP（绕过当前时间） */
async function totpAt(counter: number): Promise<string> {
  return hotp(base32Decode(RFC_SECRET_B32), counter);
}

describe("base32", () => {
  it("编码符合 RFC 4648（本实现输出无填充，验证器 App 均接受）", () => {
    // RFC 向量 "foo" → "MZXW6==="、"foobar" → "MZXW6YTBOI======"（带填充）
    expect(base32Encode(new TextEncoder().encode("foo"))).toBe("MZXW6");
    expect(base32Encode(new TextEncoder().encode("foobar"))).toBe("MZXW6YTBOI");
  });

  it("解码容忍小写/空格/填充并往返一致", () => {
    // 解码侧必须容忍带填充输入（第三方生成的密钥常含 '='）
    expect(new TextDecoder().decode(base32Decode("mzxw6 ==="))).toBe("foo");
    expect(new TextDecoder().decode(base32Decode("MZXW6YTBOI======"))).toBe("foobar");
    const secret = generateTotpSecret();
    expect(base32Encode(base32Decode(secret))).toBe(secret);
  });

  it("非法字符抛错", () => {
    expect(() => base32Decode("ABC1")).toThrow(/非法/);
    expect(() => base32Decode("")).toThrow();
  });
});

describe("hotp / RFC 6238 权威向量", () => {
  it("RFC 6238 B 节 SHA-1 首行：T=59s（counter=1）→ 287082", async () => {
    // 该向量锚定 HMAC-SHA1 + 动态截断整条链路的正确性
    expect(await totpAt(1)).toBe("287082");
  });

  it("同 counter 输出稳定、不同 counter 输出不同", async () => {
    expect(await totpAt(37037036)).toBe(await totpAt(37037036));
    expect(await totpAt(37037035)).not.toBe(await totpAt(37037036));
  });
});

describe("verifyTotp", () => {
  beforeEachMockTime();

  function beforeEachMockTime() {
    // 占位：各用例内通过 vi.setSystemTime 控制时钟
  }

  it("接受当前周期的正确验证码", async () => {
    vi.useFakeTimers();
    try {
      const secret = generateTotpSecret();
      const counter = Math.floor(Date.now() / 1000 / 30);
      const token = await hotp(base32Decode(secret), counter);
      await expect(verifyTotp(secret, token)).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("容忍 ±1 窗口漂移", async () => {
    vi.useFakeTimers();
    try {
      const secret = generateTotpSecret();
      const counter = Math.floor(Date.now() / 1000 / 30);
      const prevToken = await hotp(base32Decode(secret), counter - 1);
      await expect(verifyTotp(secret, prevToken)).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("拒绝过期窗口外的验证码与非法输入", async () => {
    vi.useFakeTimers();
    try {
      const secret = generateTotpSecret();
      const counter = Math.floor(Date.now() / 1000 / 30);
      const stale = await hotp(base32Decode(secret), counter - 5);
      await expect(verifyTotp(secret, stale)).resolves.toBe(false);
      await expect(verifyTotp(secret, "abcdef")).resolves.toBe(false);
      await expect(verifyTotp(secret, "12345")).resolves.toBe(false);
      await expect(verifyTotp("!!not-base32!!", "123456")).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("buildOtpauthUri", () => {
  it("包含密钥/发行方/算法参数", () => {
    const uri = buildOtpauthUri("JBSWY3DPEHPK3PXP", "admin@example.com");
    expect(uri.startsWith("otpauth://totp/FWP:admin%40example.com")).toBe(true);
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("issuer=FWP");
    expect(uri).toContain("digits=6");
  });
});
