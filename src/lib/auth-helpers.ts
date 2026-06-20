import { randomBytes, pbkdf2Sync as _pbkdf2Sync, timingSafeEqual } from "crypto";

/**
 * 密码哈希：使用 PBKDF2 + 随机盐值
 * 使用 Node.js 内置 crypto 模块，无需额外依赖
 */
const SALT_LENGTH = 16;
const HASH_ITERATIONS = 10000;
const KEY_LENGTH = 64;

/**
 * 哈希密码（带盐值）
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH).toString("hex");
  const hash = _pbkdf2Sync(password, salt, HASH_ITERATIONS, KEY_LENGTH, "sha256");
  return `${salt}:${hash.toString("hex")}`;
}

/**
 * 验证密码（使用 timingSafeEqual 防止时序攻击）
 */
export async function verifyPassword(
  password: string,
  storedHash: string
): Promise<boolean> {
  try {
    const [salt, hash] = storedHash.split(":");
    if (!salt || !hash) return false;

    const computedHash = _pbkdf2Sync(password, salt, HASH_ITERATIONS, KEY_LENGTH, "sha256");
    const hashBuf = Buffer.from(hash, "hex");
    const computedBuf = Buffer.from(computedHash.toString("hex"), "hex");

    if (hashBuf.length !== computedBuf.length) return false;

    return timingSafeEqual(hashBuf, computedBuf);
  } catch {
    return false;
  }
}
