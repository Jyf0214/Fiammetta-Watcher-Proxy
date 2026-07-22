/**
 * 密码哈希/验证辅助模块
 *
 * 使用 Web Crypto API（PBKDF2）进行密码哈希和验证。
 * 完全兼容 Edge Runtime，不依赖 Node.js crypto 模块。
 *
 * 存储格式：iterations:base64(salt):base64(hash)
 * - iterations: PBKDF2 迭代次数（当前 100000，可调高以增加安全性）
 * - salt: 随机盐值（16 字节）
 * - hash: 派生密钥（32 字节）
 */

// ==================== 常量 ====================

/** PBKDF2 迭代次数（OWASP 2023 建议 PBKDF2-SHA256 ≥ 600000） */
const ITERATIONS = 100000;

/** 盐值长度（字节） */
const SALT_LENGTH = 16;

/** 派生密钥长度（字节） */
const KEY_LENGTH = 32;

/** 密码最大长度限制（DoS 防护） */
const MAX_PASSWORD_LENGTH = 128;

// ==================== 密码哈希 ====================

/**
 * 哈希密码（带随机盐值）
 *
 * 使用 PBKDF2-SHA256 派生密钥，存储格式：iterations:base64(salt):base64(hash)
 *
 * @param password - 明文密码（最大 128 字符）
 * @returns 哈希后的密码字符串
 * @throws 密码超过 128 字符时抛出错误
 */
export async function hashPassword(password: string): Promise<string> {
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new Error("密码长度不能超过 128 个字符");
  }

  // 生成随机盐值
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));

  // 导入密码为原始密钥材料
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );

  // 派生密钥
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: ITERATIONS,
      hash: "SHA-256",
    },
    passwordKey,
    KEY_LENGTH * 8 // 位数 = 字节数 × 8
  );

  // 转换为 base64 并按格式存储
  const saltBase64 = uint8ArrayToBase64(salt);
  const hashBase64 = uint8ArrayToBase64(new Uint8Array(derivedBits));

  return `${ITERATIONS}:${saltBase64}:${hashBase64}`;
}

// ==================== 密码验证 ====================

/**
 * 验证密码
 *
 * 从存储的哈希中提取盐值和迭代次数，重新计算并与存储的哈希比较。
 * 使用固定时间比较（常量时间比较）防止时序攻击。
 *
 * @param password - 待验证的明文密码
 * @param storedHash - 存储的哈希字符串（格式：iterations:base64(salt):base64(hash)）
 * @returns 密码是否匹配
 */
export async function verifyPassword(
  password: string,
  storedHash: string
): Promise<boolean> {
  try {
    // 密码超长直接拒绝，不进入计算
    if (password.length > MAX_PASSWORD_LENGTH) return false;

    // 解析存储的哈希
    const [iterationsStr, saltBase64, hashBase64] = storedHash.split(":");
    if (!iterationsStr || !saltBase64 || !hashBase64) return false;

    const iterations = parseInt(iterationsStr, 10);
    if (isNaN(iterations) || iterations <= 0) return false;

    const salt = base64ToUint8Array(saltBase64);
    const storedHashBytes = base64ToUint8Array(hashBase64);

    // 使用相同的参数重新计算哈希
    const passwordKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      { name: "PBKDF2" },
      false,
      ["deriveBits"]
    );

    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: salt as unknown as ArrayBuffer,
        iterations,
        hash: "SHA-256",
      },
      passwordKey,
      storedHashBytes.length * 8 // 位数 = 字节数 × 8
    );

    const computedHash = new Uint8Array(derivedBits);

    // 固定时间比较，防止时序攻击
    return constantTimeCompare(computedHash, storedHashBytes);
  } catch {
    // 验证过程中任何异常都视为验证失败
    return false;
  }
}

// ==================== Base64 工具函数 ====================

/**
 * Uint8Array 转 Base64 字符串
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  // 在 Cloudflare Edge Runtime 中使用 btoa
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Base64 字符串转 Uint8Array
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * 固定时间字节数组比较（防止时序攻击）
 *
 * 即使两个数组长度不同，也会遍历完整长度以避免泄露长度信息。
 */
function constantTimeCompare(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    // 长度不同时仍遍历较短的长度，防止通过响应时间推断长度差异
    const minLen = Math.min(a.length, b.length);
    let diff = a.length ^ b.length; // 记录长度差异
    for (let i = 0; i < minLen; i++) {
      diff |= a[i] ^ b[i];
    }
    return diff === 0;
  }

  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}
