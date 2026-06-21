---
name: ui-component-migration
description: 跨项目复制 UI 组件的策略：依赖分析、渐进式复制、适配替代方案
source: auto-skill
extracted_at: '2026-06-21T00:30:00.000Z'
---

# UI 组件跨项目迁移策略

## 问题背景

从一个项目复制 UI 组件到另一个项目时，组件之间存在复杂的依赖链（类型定义、hooks、lib 工具函数、认证系统等）。直接复制会导致大量 TypeScript 编译错误。

## 迁移策略

### 1. 分层复制（由浅入深）

```
第一层：UI 原语（Button, Input, Tag, Skeleton 等）— 通常无外部依赖
第二层：工具函数（lib/ui.ts, hooks/）— 轻度依赖
第三层：布局组件（Navbar, Sidebar, Footer）— 深度依赖（认证、配置系统）
第四层：业务组件（HomePostGrid, SearchDialog）— 深度依赖
```

**原则**：先复制浅层组件，验证编译通过，再决定是否复制深层组件。

### 2. 依赖分析

在复制前，用 grep 检查目标组件的导入：

```bash
# 检查组件导入了哪些模块
grep -r "from '@/" components/ | sed "s/.*from '\([^']*\)'.*/\1/" | sort -u

# 检查缺失的模块
npx tsc --noEmit 2>&1 | grep "Cannot find module" | sed "s/.*Cannot find module '\([^']*\)'.*/\1/" | sort -u
```

### 3. 三种处理策略

#### 策略 A：直接复制（轻度依赖）

适用于：UI 原语、工具函数、纯展示组件

```bash
cp /source/components/ui/Button.tsx /target/src/components/ui/
cp /source/lib/ui.ts /target/src/lib/
cp /source/hooks/use-mobile.ts /target/src/hooks/
```

#### 策略 B：复制 + 补充依赖文件

适用于：有少量缺失依赖的组件

```bash
# 先复制组件
cp /source/components/Footer/index.tsx /target/src/components/Footer/

# 再复制缺失的类型和配置文件
cp /source/components/Footer/types.ts /target/src/components/Footer/
cp /source/components/Footer/footer-config.ts /target/src/components/Footer/
```

#### 策略 C：重写适配（深度依赖）

适用于：依赖认证系统、配置系统、WebDAV 等项目特定模块的组件

```tsx
// ❌ 不要复制依赖 Clerk/Auth 的组件
// import { useAuth } from '@/hooks/use-auth';  // 源项目用 Clerk，目标项目用 JWT

// ✅ 为目标项目重写简化版本
"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  useEffect(() => {
    fetch("/api/admin/auth").then(r => r.json()).then(d => {
      if (!d.success) router.push("/admin/login");
    });
  }, []);
  return <>{children}</>;
}
```

### 4. 验证清单

```bash
# 1. TypeScript 检查
npx tsc --noEmit

# 2. 列出所有缺失模块
npx tsc --noEmit 2>&1 | grep "Cannot find module" | sed "s/.*Cannot find module '\([^']*\)'.*/\1/" | sort -u

# 3. ESLint 检查
npx eslint src/

# 4. 构建验证
npm run build
```

## 常见依赖模式

### lib/ui.ts（cn 工具函数）

几乎所有 UI 组件都依赖这个：

```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
```

需要安装：`npm install clsx tailwind-merge`

### hooks/use-scroll-progress.ts

ReadingProgressBar 组件依赖：

```ts
// 需要从源项目复制 hooks/ 目录
cp /source/hooks/use-scroll-progress.ts /target/src/hooks/
```

### lucide-react 图标名称差异

不同版本的 lucide-react 图标名称可能不同：

```ts
// ❌ 旧版本名称
import { ApiOutlined, Github } from "lucide-react";

// ✅ 新版本名称
import { Server, GitFork } from "lucide-react";
```

查找正确名称：

```bash
node -e "const l = require('lucide-react'); console.log(Object.keys(l).filter(k => k.toLowerCase().includes('git')))"
```

## 决策矩阵

| 源组件依赖 | 目标项目有对应模块 | 处理策略 |
|-----------|------------------|---------|
| 纯 UI（无外部依赖） | - | 直接复制 |
| lib/ui.ts, hooks | 需安装 tailwind-merge 等 | 复制 + npm install |
| 认证系统（Clerk/Auth.js） | JWT/自定义 | 重写适配 |
| 配置系统（WebDAV/文件） | 数据库 | 重写适配 |
| 搜索/索引（Algolia/Meilisearch） | 无 | 跳过或简化 |
