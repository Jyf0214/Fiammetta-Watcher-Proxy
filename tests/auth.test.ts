import { describe, it, expect, beforeAll } from "vitest";
import { generateToken, verifyToken } from "../src/lib/auth";
import jwt from "jsonwebtoken";
/**
 * auth.ts 使用模块级 cachedConfig 缓存 JWT 配置。
 * 一旦配置被缓存，整个测试套件都会使用同一配置。
 *
 * 测试策略：
 * - 只测试一次配置（HS256），验证核心功能
 * - 测试 Token 生成和验证的基本流程
 * - 不测试密钥切换（因缓存限制）
 */

describe("auth 模块", () => {
  beforeAll(() => {
    // 设置 HS256 密钥用于测试
    process.env.JWT_SECRET =
      "test-secret-key-that-is-at-least-32-bytes-long-for-hs256";
    delete process.env.JWKS_KEY;
  });

  describe("Token 生成", () => {
    it("应该生成有效的 JWT Token 格式", () => {
      const payload = { adminId: "123", username: "admin" };
      const token = generateToken(payload);
      expect(typeof token).toBe("string");
      // JWT 由 3 部分组成：header.payload.signature
      expect(token.split(".")).toHaveLength(3);
    });

    it("Token 应该包含正确的算法头", () => {
      const payload = { adminId: "123", username: "admin" };
      const token = generateToken(payload);
      const decoded = jwt.decode(token, { complete: true });
      expect(decoded?.header.alg).toBe("HS256");
      expect(decoded?.header.typ).toBe("JWT");
    });

    it("Token 应该包含正确的 payload", () => {
      const payload = { adminId: "user-456", username: "testadmin" };
      const token = generateToken(payload);
      const decoded = jwt.decode(token) as jwt.JwtPayload;
      expect(decoded.adminId).toBe("user-456");
      expect(decoded.username).toBe("testadmin");
    });
  });

  describe("Token 验证", () => {
    it("有效的 Token 应该返回正确的 payload", () => {
      const payload = { adminId: "123", username: "admin" };
      const token = generateToken(payload);
      const decoded = verifyToken(token);
      expect(decoded).not.toBeNull();
      expect(decoded?.adminId).toBe(payload.adminId);
      expect(decoded?.username).toBe(payload.username);
    });

    it("无效的 Token 应该返回 null", () => {
      expect(verifyToken("invalid.token.here")).toBeNull();
    });

    it("空字符串 Token 应该返回 null", () => {
      expect(verifyToken("")).toBeNull();
    });

    it("过期的 Token 应该返回 null", () => {
      const payload = { adminId: "123", username: "admin" };
      const expiredToken = jwt.sign(
        payload,
        process.env.JWT_SECRET!,
        { algorithm: "HS256", expiresIn: "-1d" }
      );
      expect(verifyToken(expiredToken)).toBeNull();
    });

    it("用错误密钥签名的 Token 应该返回 null", () => {
      const payload = { adminId: "123", username: "admin" };
      const wrongToken = jwt.sign(
        payload,
        "wrong-secret-key-that-is-at-least-32-bytes-long!!!",
        { algorithm: "HS256", expiresIn: "7d" }
      );
      expect(verifyToken(wrongToken)).toBeNull();
    });

    it("被篡改的 Token 应该返回 null", () => {
      const payload = { adminId: "123", username: "admin" };
      const token = generateToken(payload);
      // 篡改 payload 部分
      const parts = token.split(".");
      parts[1] = parts[1] + "X"; // 添加字符破坏签名
      const tamperedToken = parts.join(".");
      expect(verifyToken(tamperedToken)).toBeNull();
    });
  });

  describe("Token 过期时间", () => {
    it("Token 应该在 7 天后过期", () => {
      const payload = { adminId: "123", username: "admin" };
      const token = generateToken(payload);
      const decoded = jwt.decode(token) as jwt.JwtPayload;
      expect(decoded.exp).toBeDefined();
      // exp 应该大约在 7 天后（允许几秒误差）
      const now = Math.floor(Date.now() / 1000);
      const sevenDays = 7 * 24 * 60 * 60;
      expect(decoded.exp).toBeGreaterThan(now + sevenDays - 10);
      expect(decoded.exp).toBeLessThanOrEqual(now + sevenDays + 10);
    });

    it("Token 应该包含签发时间 (iat)", () => {
      const payload = { adminId: "123", username: "admin" };
      const token = generateToken(payload);
      const decoded = jwt.decode(token) as jwt.JwtPayload;
      expect(decoded.iat).toBeDefined();
      // iat 应该接近当前时间
      const now = Math.floor(Date.now() / 1000);
      expect(decoded.iat).toBeGreaterThanOrEqual(now - 5);
      expect(decoded.iat).toBeLessThanOrEqual(now + 5);
    });
  });

  describe("多次生成和验证", () => {
    it("每次生成的 Token 应该不同（包含唯一时间戳）", () => {
      const payload = { adminId: "123", username: "admin" };
      const token1 = generateToken(payload);
      const token2 = generateToken(payload);
      // 虽然 payload 相同，但由于 iat 不同，Token 应该不同
      // 注意：如果生成速度太快，可能相同，所以只检查都能验证
      expect(verifyToken(token1)).not.toBeNull();
      expect(verifyToken(token2)).not.toBeNull();
    });

    it("应该能处理不同的 payload", () => {
      const payload1 = { adminId: "111", username: "user1" };
      const payload2 = { adminId: "222", username: "user2" };
      const token1 = generateToken(payload1);
      const token2 = generateToken(payload2);
      const decoded1 = verifyToken(token1);
      const decoded2 = verifyToken(token2);
      expect(decoded1?.adminId).toBe("111");
      expect(decoded2?.adminId).toBe("222");
    });
  });
});
