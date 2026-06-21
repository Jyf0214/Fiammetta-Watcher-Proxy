---
name: prisma-provider-limitation
description: Prisma datasource provider 不支持 env() 动态切换数据库的已知限制与解决方案
source: auto-skill
extracted_at: '2026-06-20T14:47:34.936Z'
---

# Prisma Provider 字段不支持 env()

## 问题描述

Prisma schema 中 `datasource db` 的 `provider` 字段**不能**使用 `env()` 函数：

```prisma
// ❌ 这会报错：A datasource must not use the env() function in the provider argument
datasource db {
  provider = env("DB_PROVIDER")
  url      = env("DATABASE_URL")
}
```

错误信息：`P1012: A datasource must not use the env() function in the provider argument.`

## 解决方案

### 方案一：静态 provider（推荐，简单场景）

在 schema.prisma 中写死一个 provider，MySQL 用户手动修改或提供两份 schema：

```prisma
datasource db {
  provider = "postgresql"  // 或 "mysql"
  url      = env("DATABASE_URL")
}
```

**适用场景**：用户明确知道自己用什么数据库，部署时手动选择 schema。

### 方案二：prisma.config.ts（Prisma 6.x+）

```ts
// prisma.config.ts
import path from "node:path";
import type { PrismaConfig } from "prisma";

export default {
  schema: path.join(__dirname, "prisma", "schema.prisma"),
} satisfies PrismaConfig;
```

注意：`PrismaConfig` 类型可能在某些版本中不可用，需要确认当前 Prisma 版本支持。

### 方案三：运行时动态生成 schema（高级）

在 pre-start 脚本中根据环境变量生成 schema 文件，但这增加了复杂度，不推荐。

## 验证方法

```bash
# 检查 Prisma schema 是否有效
npx prisma validate

# 生成客户端
npx prisma generate
```

## 相关错误

- `P1012: A datasource must not use the env() function in the provider argument` — provider 字段使用了 env()
- `Prisma schema validation - (get-config wasm)` — schema 配置解析失败
