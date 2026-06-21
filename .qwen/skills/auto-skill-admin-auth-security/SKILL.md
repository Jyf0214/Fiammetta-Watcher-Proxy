---
name: admin-auth-security
description: 管理后台认证安全模式：登录速率限制、PBKDF2 密码哈希、JWT 安全配置
source: auto-skill
extracted_at: '2026-06-21T00:30:00.000Z'
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
