---
name: admin-auth-security
description: 管理后台认证安全模式：登录速率限制、PBKDF2 密码哈希、JWT RS256/HS256 自动识别、Cookie 代理适配、管理员自动初始化与密码重置
source: auto-skill
extracted_at: '2026-06-26T13:59:34.117Z'
---

# 管理后台认证安全模式

## 1. 登录端点速率限制

在 Route Handler 中实现基于 IP 的内存速率限制器：

```ts
// 模块级存储
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 分钟

function checkLoginRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const entry = loginAttempts.get(ip);

  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true };
  }

  if (entry.count >= MAX_ATTEMPTS) {
    return { allowed: false, retryAfter: entry.resetAt };
  }

  entry.count += 1;
  return { allowed: true };
}

function resetLoginAttempts(ip: string) {
  loginAttempts.delete(ip);
}

// 在 POST handler 中使用
const ip = request.headers.get("x-forwarded-for") || "unknown";
const rateCheck = checkLoginRateLimit(ip);
if (!rateCheck.allowed) {
  return NextResponse.json(
    { success: false, error: `登录尝试过多，请在 ${Math.ceil((rateCheck.retryAfter! - Date.now()) / 60000)} 分钟后重试` },
    { status: 429 }
  );
}

// 登录成功后重置计数
resetLoginAttempts(ip);
```

## 2. PBKDF2 密码哈希（无外部依赖）

使用 Node.js 内置 `crypto` 模块的 PBKDF2，无需安装 bcrypt：

```ts
import { randomBytes, pbkdf2Sync, timingSafeEqual } from "crypto";

const SALT_LENGTH = 16;
const HASH_ITERATIONS = 10000;
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH).toString("hex");
  const hash = pbkdf2Sync(password, salt, HASH_ITERATIONS, KEY_LENGTH, "sha256");
  return `${salt}:${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [salt, hash] = storedHash.split(":");
  if (!salt || !hash) return false;

  const computedHash = pbkdf2Sync(password, salt, HASH_ITERATIONS, KEY_LENGTH, "sha256");
  const hashBuf = Buffer.from(hash, "hex");
  const computedBuf = Buffer.from(computedHash.toString("hex"), "hex");

  if (hashBuf.length !== computedBuf.length) return false;
  return timingSafeEqual(hashBuf, computedBuf); // 防时序攻击
}
```

**注意**：存储格式为 `salt:hash`，验证时需要分割。`timingSafeEqual` 防止时序侧信道攻击。

## 3. JWT 安全配置

```ts
// ❌ 绝对不要这样做
const JWT_SECRET = process.env.JWT_SECRET || "default-secret";

// ✅ 正确：缺失时抛出错误，禁止使用弱密钥
function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET 环境变量未配置，无法生成或验证 Token");
  }
  return secret;
}
```

## 4. Next.js App Router 动态路由参数

```ts
// ❌ 错误：[id]/route.ts 中使用 query 参数
export async function PUT(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id"); // 永远是 null
}

// ✅ 正确：使用 params 路径参数
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params; // Next.js 15+ 中 params 是 Promise
}
```

## 5. API 输入验证模式

```ts
// parseInt NaN 防护
const page = Math.max(1, parseInt(searchParams.get("page") || "1") || 1);
const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get("pageSize") || "20") || 20));

// ?? vs ||：0 值不会被误判为 falsy
const rpmLimit = body.rpmLimit ?? null; // ✅ 保留 0
const rpmLimit = body.rpmLimit || null; // ❌ 0 会变成 null

// 枚举验证
const validTypes = ["openai", "azure", "custom"];
const type = validTypes.includes(body.type) ? body.type : "openai";
```

## 6. 登录速率限制器自清理

速率限制器 Map 需要定期清理过期条目，防止内存泄漏：

```ts
// 模块底部自初始化
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts.entries()) {
    if (now > entry.resetAt) loginAttempts.delete(ip);
  }
}, 60_000); // 每分钟清理
```

## 7. DELETE handler 也需要 request 参数

```ts
// ❌ 错误：DELETE 没有 request 参数，无法获取 IP
export async function DELETE() {
  const ip = "unknown"; // 永远是 unknown
}

// ✅ 正确：DELETE 也需要 NextRequest 参数
export async function DELETE(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for") || "unknown";
  // ... 审计日志记录 IP
}
```

## 8. 失败登录也要记录审计日志

```ts
// 密码验证失败时记录
if (!valid) {
  await prisma.auditLog.create({
    data: {
      action: "login_failed",
      detail: JSON.stringify({ username }),
      ip: clientIp,
    },
  });
  return NextResponse.json({ success: false, error: "用户名或密码错误" }, { status: 401 });
}
```

## 9. JWT RS256/HS256 自动识别（支持 JWKS/JWK/PEM/字符串）

环境变量 `JWKS_KEY`（优先）或 `JWT_SECRET` 自动识别密钥格式：

```ts
import jwt from "jsonwebtoken";
import { createPrivateKey, createPublicKey } from "crypto";

interface Hs256Config { type: "hs256"; secret: string }
interface Rs256Config { type: "rs256"; privateKey: KeyObject; publicKey: KeyObject }
type JwtConfig = Hs256Config | Rs256Config;

function parseJwtConfig(): JwtConfig {
  const raw = process.env.JWKS_KEY || process.env.JWT_SECRET;
  if (!raw) throw new Error("JWKS_KEY 或 JWT_SECRET 未配置");

  const trimmed = raw.trim();

  // JWKS: { keys: [{ kty: "RSA", d: "..." }] }
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    const jwk = parsed.keys?.[0] ?? parsed;
    if (jwk.kty && jwk.d) {
      const privateKey = createPrivateKey({ key: jwk, format: "jwk" });
      const publicKey = createPublicKey(privateKey); // 从私钥推导公钥
      return { type: "rs256", privateKey, publicKey };
    }
    throw new Error("JSON 不是有效的 JWK/JWKS（需包含 kty 和 d 字段）");
  }

  // PEM: -----BEGIN PRIVATE KEY-----
  if (trimmed.includes("-----BEGIN") && trimmed.includes("PRIVATE KEY")) {
    const privateKey = createPrivateKey(trimmed);
    const publicKey = createPublicKey(privateKey);
    return { type: "rs256", privateKey, publicKey };
  }

  // 默认 HS256
  return { type: "hs256", secret: trimmed };
}
```

**关键规则：**
- `jwt.sign` → 用 `privateKey` 签名
- `jwt.verify` → 用 `publicKey` 验证（**不能用私钥验证，会静默失败**）
- 从私钥推导公钥：`createPublicKey(privateKey)`

## 10. Cookie 代理适配（HF Space / Vercel / Cloudflare）

```ts
// ❌ 错误：代理后 secure 可能导致 Cookie 未被设置
cookieStore.set(COOKIE_NAME, token, {
  secure: process.env.NODE_ENV === "production", // 代理后 Node.js 看到 HTTP
});

// ✅ 正确：代理环境设为 false，让浏览器自行决定
cookieStore.set(COOKIE_NAME, token, {
  httpOnly: true,
  secure: false, // HF Space 代理后必须为 false
  sameSite: "lax",
  maxAge: 7 * 24 * 60 * 60,
  path: "/",
});
```

**原因：** HF Space / Vercel 等平台的反向代理终止 HTTPS 后转发 HTTP 到 Node.js。`secure: true` 时，Node.js 设置 `Set-Cookie: ...; Secure`，但某些代理会剥离或忽略该标志，导致浏览器未存储 Cookie，后续请求无 Cookie → 401 → 重定向到登录页。

## 11. 管理员自动初始化（登录时兜底）

在登录 API 中检测数据库管理员数量，无管理员时从环境变量创建：

```ts
// POST /api/admin/auth 登录处理中
const adminCount = await prisma.admin.count();
if (adminCount === 0) {
  const envUsername = process.env.ADMIN_USERNAME;
  const envPassword = process.env.ADMIN_PASSWORD;
  if (envUsername && envPassword) {
    const { hashPassword } = await import("@/lib/auth");
    const passwordHash = await hashPassword(envPassword);
    await prisma.admin.create({
      data: { username: envUsername, passwordHash },
    });
  }
}
```

**配合忘记密码功能：** 用户点击「忘记密码」→ POST 写入 `Config` 表 `admin_reset_password: "pending"` → 下次登录时检测标志，用 `ADMIN_PASSWORD` 环境变量重新哈希密码并更新。

## 12. 密码重置标志处理（登录时）

```ts
// 检测重置标志
const resetFlag = await prisma.config.findUnique({
  where: { key: "admin_reset_password" },
});
if (resetFlag && resetFlag.value === "pending") {
  const envPassword = process.env.ADMIN_PASSWORD;
  if (envPassword) {
    const { hashPassword } = await import("@/lib/auth");
    const newHash = await hashPassword(envPassword);
    await prisma.admin.update({
      where: { id: admin.id },
      data: { passwordHash: newHash },
    });
    await prisma.config.delete({ where: { key: "admin_reset_password" } });
    targetHash = newHash; // 用新哈希验证
  }
}
```

**安全约束：**
- 重置后严禁使用环境变量密码直接登录，必须经过哈希对比
- 若数据库存在多个管理员，拒绝重置（需手动统一）
- 若 `ADMIN_USERNAME` 与现有管理员不匹配，拒绝重置
