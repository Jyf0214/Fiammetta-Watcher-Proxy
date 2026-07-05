import { randomBytes, pbkdf2Sync as _pbkdf2Sync, timingSafeEqual } from "crypto";

/**
 * 密码哈希：使用 PBKDF2 + 随机盐值
 * 使用 Node.js 内置 crypto 模块，无需额外依赖
 */
const SALT_LENGTH = 16;
// OWASP 2023 推荐 PBKDF2-SHA256 迭代次数为 600000，抵御暴力破解
const HASH_ITERATIONS = 600000;
const KEY_LENGTH = 64;

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
  return `${salt}:${hash.toString("hex")}`;
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
    if (!salt || !hash) return false;

    const computedHash = _pbkdf2Sync(password, salt, HASH_ITERATIONS, KEY_LENGTH, "sha256");
    const hashBuf = Buffer.from(hash, "hex");
    const computedBuf = Buffer.from(computedHash.toString("hex"), "hex");

    if (hashBuf.length !== computedBuf.length) return false;

    return timingSafeEqual(hashBuf, computedBuf);
  } catch {
    // 验证过程中任何异常（如格式错误）都视为验证失败，返回 false
    return false;
  }
}
