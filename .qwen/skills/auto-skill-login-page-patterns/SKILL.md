---
name: login-page-patterns
description: Next.js 登录页可靠实现模式：原生表单优于 Ant Design Form，管理员账户自动初始化，忘记密码流程
source: auto-skill
extracted_at: '2026-06-26T10:43:23.064Z'
---

# 登录页可靠实现模式

## 1. 优先使用原生 HTML 表单

Ant Design `Form` 组件的 `form.submit()` 在某些场景下不可靠：
- 按钮放在 `Input` 的 `suffix` prop 内时，点击事件可能不触发
- `message.success()` / `message.error()` 可能不渲染
- 客户端 hydration 后表单行为异常

**推荐方案**：使用原生 `<form onSubmit>` + 受控状态：

```tsx
"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<"username" | "password">("username");

  useEffect(() => {
    document.getElementById(step === "username" ? "login-username" : "login-password")?.focus();
  }, [step]);

  const handleSubmitUsername = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!username.trim()) { setError("用户名不能为空"); return; }
    setStep("password");
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!password) { setError("密码不能为空"); return; }
    setLoading(true);
    try {
      const res = await fetch("/api/admin/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = await res.json();
      if (data.success) { router.push("/admin"); }
      else { setError(data.error || "登录失败"); }
    } catch { setError("网络错误"); }
    finally { setLoading(false); }
  };

  return (
    <form onSubmit={step === "username" ? handleSubmitUsername : handleLogin}>
      {/* ... */}
      {error && <div className="px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-red-600 text-sm">{error}</div>}
      <button type="submit" disabled={loading}>
        {loading ? <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" /> : "登录"}
      </button>
    </form>
  );
}
```

## 2. 错误/成功反馈用 DOM 直接显示

不依赖 antd `message` 组件，直接用状态变量 + DOM 渲染：

```tsx
const [error, setError] = useState("");
const [success, setSuccess] = useState("");

{error && (
  <div className="px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 text-sm">
    {error}
  </div>
)}
{success && (
  <div className="px-3 py-2 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-green-600 dark:text-green-400 text-sm">
    {success}
  </div>
)}
```

## 3. 管理员账户初始化（多重保障）

必须在多个位置执行初始化，确保任何启动方式都能创建管理员：

### 3.1 Next.js instrumentation.ts（推荐主路径）

```ts
// src/instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initializeAdmin } = await import("./services/init");
    await initializeAdmin();
  }
}
```

### 3.2 Docker entrypoint（备份路径）

```bash
# docker-entrypoint.sh
node scripts/init-admin.js || echo "[init-admin] 跳过"
```

### 3.3 登录 API 内检测（兜底路径）

在登录 API 中检测：若数据库无管理员，立即从环境变量创建。

```ts
// POST /api/admin/auth 中
const adminCount = await prisma.admin.count();
if (adminCount === 0) {
  const envUsername = process.env.ADMIN_USERNAME;
  const envPassword = process.env.ADMIN_PASSWORD;
  if (envUsername && envPassword) {
    const { hashPassword } = await import("@/lib/auth");
    const passwordHash = await hashPassword(envPassword);
    await prisma.admin.create({ data: { username: envUsername, passwordHash } });
  }
}
```

### ⚠️ 密码哈希算法必须一致

`init-admin.js`（Node.js 独立脚本）必须与 `auth-helpers.ts`（TypeScript 模块）使用完全相同的参数：

| 参数 | 正确值 | 错误值（会导致登录失败） |
|------|--------|--------------------------|
| 算法 | sha256 | sha512 |
| 迭代次数 | 10000 | 100000 |
| Key 长度 | 64 | 64 |
| 格式 | `salt:hex` | `salt:hex` |

```javascript
// scripts/init-admin.js — 正确的哈希实现
const crypto = require("crypto");
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, "sha256");
  return `${salt}:${hash.toString("hex")}`;
}
```

## 4. 忘记密码流程

### 4.1 流程设计

```
用户点击「忘记密码」
  → POST /api/admin/auth/reset-password
  → 写入 Config 表 admin_reset_password = "pending"
  → 下次服务启动时 initializeAdmin() 检测到标志
  → 用 ADMIN_PASSWORD 环境变量强制更新密码
  → 删除标志
```

### 4.2 安全约束

1. **单管理员检查**：数据库中只能有 1 个管理员，否则拒绝
2. **名称匹配检查**：ADMIN_USERNAME 必须与现有管理员用户名一致，否则拒绝并提示修改环境变量
3. **环境变量检查**：ADMIN_USERNAME 和 ADMIN_PASSWORD 必须都已配置

### 4.3 API 实现

```ts
// POST /api/admin/auth/reset-password
const FLAG_KEY = "admin_reset_password";

export async function POST() {
  const adminCount = await prisma.admin.count();
  if (adminCount === 0) return NextResponse.json({ success: false, error: "无管理员账户" }, { status: 400 });
  if (adminCount > 1) return NextResponse.json({ success: false, error: `存在 ${adminCount} 个管理员，无法自动重置` }, { status: 400 });

  const envUsername = process.env.ADMIN_USERNAME;
  const envPassword = process.env.ADMIN_PASSWORD;
  if (!envUsername || !envPassword) return NextResponse.json({ success: false, error: "未配置环境变量" }, { status: 400 });

  const admin = await prisma.admin.findFirst();
  if (admin && admin.username !== envUsername) {
    return NextResponse.json({ success: false, error: `ADMIN_USERNAME="${envUsername}" 与数据库管理员 "${admin.username}" 不匹配` }, { status: 400 });
  }

  await prisma.config.upsert({ where: { key: FLAG_KEY }, update: { value: "pending" }, create: { key: FLAG_KEY, value: "pending" } });
  return NextResponse.json({ success: true, message: "密码重置标志已写入，下次启动时更新" });
}
```

### 4.4 启动时处理

```ts
// initializeAdmin() 中
const resetFlag = await prisma.config.findUnique({ where: { key: "admin_reset_password" } });
if (resetFlag && resetFlag.value === "pending") {
  // 再次验证管理员名称匹配
  if (admin.username !== envUsername) {
    console.error(`[初始化] 错误：ADMIN_USERNAME="${envUsername}" 与数据库管理员 "${admin.username}" 不匹配`);
    return;
  }
  const newHash = await hashPassword(password);
  await prisma.admin.update({ where: { id: admin.id }, data: { passwordHash: newHash } });
  await prisma.config.delete({ where: { key: "admin_reset_password" } });
}
```

## 5. 两步登录流程

分步登录（用户名 → 密码）比单步更友好：

```tsx
const [step, setStep] = useState<"username" | "password">("username");

// 用户名步骤：验证后切换到密码步骤
const handleSubmitUsername = (e: React.FormEvent) => {
  e.preventDefault();
  if (!username.trim()) return;
  setStep("password");
};

// 密码步骤：提交登录
const handleLogin = async (e: React.FormEvent) => {
  e.preventDefault();
  // fetch /api/admin/auth ...
};
```

## 6. HF Space 环境变量

| Secret | 用途 |
|--------|------|
| `ADMIN_USERNAME` | 管理员用户名 |
| `ADMIN_PASSWORD` | 管理员密码 |
| `JWT_SECRET` | JWT Token 签名密钥 |
| `DATABASE_URL` | 数据库连接字符串 |

## 7. 注意事项

- **HF Space 会暂停**：长时间不活跃的 Space 会被自动暂停，需要手动重启
- **仪表盘调试接口**：可添加 `/api/admin/debug` 检查环境变量和管理员状态
- **密码哈希一致性**：init-admin.js 和 auth-helpers.ts 必须使用完全相同的哈希参数，否则登录永远失败
