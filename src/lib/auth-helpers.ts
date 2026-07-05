import { randomBytes, pbkdf2Sync as _pbkdf2Sync, timingSafeEqual } from "crypto";

/**
 * 密码哈希：使用 PBKDF2 + 随机盐值
 * 使用 Node.js 内置 crypto 模块，无需额外依赖
 */
const SALT_LENGTH = 16;
// OWASP 2023 推荐 PBKDF2-SHA256 迭代次数为 600000，抵御暴力破解
const HASH_ITERATIONS = 600000;
const KEY_LENGTH = 64;

const isDebug = process.env.LOGIN_DEBUG === "true";

/**
 * 哈希密码（带盐值）
 * 密码最大长度限制为 128 字节，防止超长密码在 PBKDF2 高迭代次数下消耗过多 CPU（DoS 防护）
 */
export async function hashPassword(password: string): Promise<string> {
  if (password.length > 128) {
    throw new Error("密码长度不能超过 128 个字符");
  }
  const salt = randomBytes(SALT_LENGTH).toString("hex");
  const hash = _pbkdf2Sync(password, salt, HASH_ITERATIONS, KEY_LENGTH, "sha256");
  const result = `${salt}:${hash.toString("hex")}`;
  if (isDebug) {
    console.log("[LOGIN_DEBUG] hashPassword:", {
      passwordLength: password.length,
      salt: salt,
      hashPrefix: result.substring(0, 50) + "...",
      fullHash: result,
    });
  }
  return result;
}

/**
 * 验证密码（使用 timingSafeEqual 防止时序攻击）
 * 密码最大长度限制为 128 字节，防止超长密码在 PBKDF2 高迭代次数下消耗过多 CPU（DoS 防护）
 */
export async function verifyPassword(
  password: string,
  storedHash: string
): Promise<boolean> {
  try {
    // 密码超长直接拒绝，不进入计算
    if (password.length > 128) return false;

    const [salt, hash] = storedHash.split(":");
    if (!salt || !hash) {
      if (isDebug) {
        console.log("[LOGIN_DEBUG] verifyPassword: 存储的哈希格式无效", {
          storedHashPrefix: storedHash.substring(0, 30),
          hasSalt: !!salt,
          hasHash: !!hash,
        });
      }
      return false;
    }

    const computedHash = _pbkdf2Sync(password, salt, HASH_ITERATIONS, KEY_LENGTH, "sha256");
    const hashBuf = Buffer.from(hash, "hex");
    const computedBuf = Buffer.from(computedHash.toString("hex"), "hex");

    if (isDebug) {
      console.log("[LOGIN_DEBUG] verifyPassword 详情:", {
        passwordLength: password.length,
        storedSalt: salt,
        storedHashPrefix: hash.substring(0, 40) + "...",
        computedHashPrefix: computedHash.toString("hex").substring(0, 40) + "...",
        storedHashLength: hash.length,
        computedHashLength: computedHash.toString("hex").length,
        hashBufLength: hashBuf.length,
        computedBufLength: computedBuf.length,
        lengthMatch: hashBuf.length === computedBuf.length,
      });
    }

    if (hashBuf.length !== computedBuf.length) return false;

    const result = timingSafeEqual(hashBuf, computedBuf);
    if (isDebug) {
      console.log("[LOGIN_DEBUG] verifyPassword 结果:", { match: result });
    }
    return result;
  } catch (e) {
    if (isDebug) {
      console.log("[LOGIN_DEBUG] verifyPassword 异常:", e);
    }
    // 验证过程中任何异常（如格式错误）都视为验证失败，返回 false
    return false;
  }
}

/**
 * [调试专用] 直接对比两个密码哈希，用于诊断加解密问题
 */
export async function debugCompareHashes(password1: string, password2: string): Promise<{
  hash1: string;
  hash2: string;
  match: boolean;
  password1Length: number;
  password2Length: number;
}> {
  const h1 = await hashPassword(password1);
  const h2 = await hashPassword(password2);

  // 用 password1 的哈希去验证 password2
  const verifyResult = await verifyPassword(password2, h1);

  return {
    hash1: h1,
    hash2: h2,
    match: verifyResult,
    password1Length: password1.length,
    password2Length: password2.length,
  };
}
