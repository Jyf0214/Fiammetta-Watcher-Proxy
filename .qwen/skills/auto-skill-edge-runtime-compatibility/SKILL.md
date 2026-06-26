---
name: edge-runtime-compatibility
description: Next.js Edge runtime 与 Node.js API 不兼容问题的诊断与解决方案
source: auto-skill
extracted_at: '2026-06-21T03:12:14.594Z'
---

## 问题

Next.js middleware 默认运行在 Edge runtime，不支持 Node.js 特有的 API（如 `fs`、`crypto`、`child_process`）和依赖 Node.js 的库（如 Prisma）。在 middleware 中导入这些模块会导致：
- 请求完全无响应
- 页面加载后 JavaScript 不执行
- 无错误提示，无重定向

## 错误模式

```typescript
// src/middleware.ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// ❌ Prisma 依赖 Node.js API，Edge runtime 不支持
import { prisma } from "@/lib/prisma";

export async function middleware(request: NextRequest) {
  // 这段代码在 Edge runtime 中无法执行
  await prisma.admin.findMany();
  return NextResponse.next();
}
```

## 诊断方法

1. **症状**：页面加载正常但无交互响应，控制台无错误
2. **检查**：查看 Next.js 构建输出是否显示 `ƒ Proxy (Middleware)`
3. **验证**：在 middleware 中尝试导入 Node.js 模块（如 `fs`），如果构建失败则确认是 Edge runtime 问题

## 解决方案

### 方案 1：移除 middleware（推荐）

如果 middleware 的功能可以通过其他方式实现，直接移除：

```bash
rm src/middleware.ts
```

将初始化逻辑移到启动脚本（如 `docker-entrypoint.sh`）。

### 方案 2：使用 Node.js runtime

在 middleware 中显式声明使用 Node.js runtime：

```typescript
export const config = {
  matcher: ["/admin/:path*"],
  runtime: "nodejs",  // ✅ 显式使用 Node.js runtime
};
```

**注意**：此方案在某些部署环境（如 Vercel Edge）可能不可用。

### 方案 3：分离 middleware 和业务逻辑

将 middleware 保持简单（仅做路由判断），复杂逻辑放到 API 路由：

```typescript
// src/middleware.ts - 仅做路由判断
export async function middleware(request: NextRequest) {
  // 仅做简单的路由重定向或 header 设置
  if (request.nextUrl.pathname.startsWith("/admin")) {
    // 仅设置 header，不调用任何 Node.js API
    const response = NextResponse.next();
    response.headers.set("x-admin-route", "true");
    return response;
  }
  return NextResponse.next();
}
```

### 方案 4：启动脚本初始化

对于需要数据库操作的初始化逻辑，使用独立脚本：

```javascript
// scripts/init-admin.js
const { PrismaClient } = require("@prisma/client");
// 纯 Node.js 脚本，可在 docker-entrypoint.sh 中调用
```

```bash
# docker-entrypoint.sh
node scripts/init-admin.js
```

## 适用场景

- Next.js middleware 中需要使用 Prisma、数据库连接
- 需要在请求处理前执行 Node.js 特有操作（文件读写、加密等）
- 部署到 Edge runtime 环境（Vercel Edge、Cloudflare Workers）

## 常见陷阱

1. **动态导入不等于安全**：`await import("@/lib/prisma")` 在 Edge runtime 中仍然会失败
2. **条件导入也不行**：即使只在特定条件下导入，Edge runtime 仍会解析模块依赖
3. **构建时可能成功**：Next.js 构建可能不会检测到 middleware 中的 Edge runtime 兼容性问题，运行时才会暴露

## 最佳实践

- middleware 保持轻量：仅做路由重定向、header 设置、cookie 操作
- 需要数据库/API 调用的逻辑放到 API 路由或服务层
- 启动时的初始化逻辑放在 `docker-entrypoint.sh` 或独立脚本中
- 在 CI 中添加 Edge runtime 兼容性检查（如尝试在 Edge 模式下构建）
