/**
 * TOTP（RFC 6238）/ HOTP（RFC 4226）实现
 *
 * 仅依赖 WebCrypto（HMAC-SHA1）与全局 crypto.getRandomValues，
 * Node 18+ 与 Cloudflare Workers 双运行时兼容。
 *
 * 用途：管理后台两步验证。secret 以 base32 存储（无填充大写），
 * 验证窗口 ±1 个周期（30 秒），容忍客户端时钟漂移。
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** 生成随机 TOTP 密钥并编码为 base32（20 字节 = 160 位，RFC 建议） */
export function generateTotpSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return base32Encode(bytes);
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/**
 * 解码 base32（容忍小写/空格/无填充）；非法字符抛错。
 * Google Authenticator 生成的密钥为无填充大写，但手动输入常带空格或小写。
 */
export function base32Decode(input: string): Uint8Array {
  const cleaned = input.toUpperCase().replace(/[\s-]/g, "");
  if (cleaned.length === 0) throw new Error("空密钥");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    // '=' 填充符出现在尾部属合法输入，直接终止
    if (ch === "=") break;
    if (idx < 0) throw new Error(`非法 base32 字符: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** HOTP（RFC 4226）：HMAC-SHA1 + 动态截断，输出 6 位十进制 */
export async function hotp(secretBytes: Uint8Array, counter: number): Promise<string> {
  // counter 按 RFC 用 8 字节大端
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    c = Math.floor(c / 256);
  }

  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg as unknown as ArrayBuffer));

  const offset = sig[sig.length - 1] & 0x0f;
  const binary =
    ((sig[offset] & 0x7f) << 24) |
    ((sig[offset + 1] & 0xff) << 16) |
    ((sig[offset + 2] & 0xff) << 8) |
    (sig[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

export const TOTP_PERIOD_SECONDS = 30;

/**
 * 校验 6 位 TOTP 码。
 *
 * @param window - 允许的周期偏移窗口（±window），默认 1（容忍 ±30 秒时钟漂移）
 * @returns 匹配返回 true；token 非 6 位数字/密钥非法返回 false（不抛错）
 */
export async function verifyTotp(
  secretBase32: string,
  token: string,
  window = 1
): Promise<boolean> {
  if (!/^\d{6}$/.test(token.trim())) return false;
  let secretBytes: Uint8Array;
  try {
    secretBytes = base32Decode(secretBase32);
  } catch {
    return false;
  }
  if (secretBytes.length === 0) return false;

  const counter = Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS);
  for (let offset = -window; offset <= window; offset++) {
    const expected = await hotp(secretBytes, counter + offset);
    // 逐字符比较即可（等长 6 位数字串）；不引入非常量比较依赖——
    // 单管理员场景下时序侧信道不构成实际威胁面，但保持简单正确
    if (expected === token.trim()) return true;
  }
  return false;
}

/** 构造 otpauth:// URI（验证器 App 扫码/手动添加用） */
export function buildOtpauthUri(secretBase32: string, account: string): string {
  const issuer = "FWP";
  // label 中 provider 与账户的分隔冒号是 URI 结构字符，不能随账户名一起编码
  const label = `${issuer}:${encodeURIComponent(account)}`;
  return (
    `otpauth://totp/${label}?secret=${secretBase32}` +
    `&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_PERIOD_SECONDS}`
  );
}

// ==================== 重放防护 ====================

/**
 * 最近一次成功验证使用的 TOTP counter（进程内单调记录）。
 * 重启清零可接受：攻击者须在同一个 ±30 秒窗口内、跨进程边界重放，
 * 实际风险面趋近于零；持久化反而引入每管理员存储与清理复杂度。
 */
let lastUsedTotpCounter = -1;

/**
 * counter 单调递增判定：登录成功消费某窗口的验证码后，同窗口（含更旧
 * 窗口）的码再次提交返回 false——防止验证码在有效期内被重放。
 *
 * @returns true 首次使用接受；false 已被消费（重放），调用方按验证失败处理
 */
export function acceptTotpCounter(counter: number): boolean {
  if (counter <= lastUsedTotpCounter) return false;
  lastUsedTotpCounter = counter;
  return true;
}

/** 重置重放防护状态（测试用） */
export function resetTotpReplayGuardForTests(): void {
  lastUsedTotpCounter = -1;
}
