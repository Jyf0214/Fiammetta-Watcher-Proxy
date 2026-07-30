# 架构说明

FWP 采用**双模式构建架构**，同一套代码库可根据部署平台自动切换运行模式。

## 双模式架构

### Cloudflare 模式

当 `CF_DEPLOY=true` 环境变量存在时，构建系统自动切换到 Cloudflare 模式：

```
┌─────────────────────────────────────────┐
│            Cloudflare Edge              │
│                                         │
│  Worker (/v1/* 代理 + Cron 定时任务)     │
│       ↓                                 │
│  D1 数据库 (SQLite via Binding)          │
│                                         │
│  Pages (前端 + 管理 API + 设置 API)      │
│       ↓                                 │
│  D1 数据库 (共享)                        │
└─────────────────────────────────────────┘
```

- **Worker** 处理所有 `/v1/*` 代理请求和 Cron 定时任务
- **Pages** 处理前端静态资源和管理后台 API
- 两者共享同一个 D1 数据库（通过 Binding）

### 非 Cloudflare 模式（默认）

```
┌─────────────────────────────────────────┐
│         Node.js 服务器                   │
│                                         │
│  Next.js Server                         │
│  ├── /v1/* 代理（Pages API 路由）        │
│  ├── /api/cron/* 定时任务（HTTP 端点）    │
│  ├── /api/admin/* 管理 API               │
│  └── 前端静态资源                        │
│       ↓                                 │
│  TiDB / PostgreSQL (DATABASE_URL)       │
└─────────────────────────────────────────┘
```

- `/v1/*` 代理由 Pages API 路由 `pages/api/v1/[[...v1]].ts` 处理
- Cron 任务通过 `pages/api/cron/[[...cron]].ts` 暴露为 HTTP 端点
- 速率限制使用内存 Map 存储（非 KV）
- 数据库通过 `DATABASE_URL` 连接

## 构建门控机制

构建时通过 shell 脚本自动处理路由切换：

### build-gate.sh（构建前）

```
CF_DEPLOY=true → 将 pages/api/v1/ 和 pages/api/cron/ 移到 .build-gate-tmp/
```

这确保 Cloudflare 构建时不会将 v1 和 cron 路由打包到 Pages 中（这些由 Worker 处理）。

### 构建过程

```bash
# package.json 中的 build:cf 脚本
CF_DEPLOY=true bash scripts/build-gate.sh &&
node scripts/prepare-db.mjs &&
opennextjs-cloudflare build &&
CF_DEPLOY=true bash scripts/build-gate-restore.sh
```

### build-gate-restore.sh（构建后）

```
CF_DEPLOY=true → 将 .build-gate-tmp/ 中的文件还原到原位
```

::: warning 注意
构建完成后必须还原路由文件，否则本地开发和非 Cloudflare 部署会缺少 `/v1/*` 和 `/api/cron/*` 路由。
:::

## Worker 模块复用

Pages API 路由（`pages/api/v1/[[...v1]].ts`）通过相对路径导入 Worker 业务模块：

```typescript
import { validateApiKey } from "../../../worker/src/auth";
import { routeRequest } from "../../../worker/src/router";
import { getNextKey } from "../../../worker/src/platform-keys";
```

这种设计确保：
- 业务逻辑只维护一份（在 `worker/src/` 下）
- Pages API 和 Worker 共享相同的路由、认证、负载均衡逻辑
- 模块通过 `createDb()` 工厂函数获取数据库连接，而非直接使用 D1 Binding

## 数据库适配层

FWP 使用 Prisma 7 多 Schema 方案支持多种数据库：

```
prisma/
├── schema.d1.prisma     → Cloudflare D1（wasm runtime）
├── schema.mysql.prisma  → TiDB / MySQL
└── schema.pg.prisma     → PostgreSQL
```

三个 Schema 定义相同的表结构，但使用不同的 Generator 和 Runtime：

| Schema | Generator | Runtime | 适配器 |
|--------|-----------|---------|--------|
| `schema.d1.prisma` | `prisma-client-js` | `cloudflare` | `@prisma/adapter-d1` |
| `schema.mysql.prisma` | `prisma-client-js` | `node` | `mysql2` |
| `schema.pg.prisma` | `prisma-client-js` | `node` | `@prisma/pg-worker` |

`scripts/prepare-db.mjs` 根据 `DB_TYPE` 环境变量自动选择对应的 Schema 并执行迁移。

## 速率限制实现差异

| 环境 | 存储 | 持久化 | 说明 |
|------|------|--------|------|
| Cloudflare Worker | KV Namespace | ✅ 持久化 | 冷启动不丢失 |
| Pages API（非 CF 模式） | 内存 Map | ❌ 非持久化 | 冷启动后重置 |

两种实现共享相同的接口（`checkPlatformRpm`、`checkApiKeyRpm` 等），仅底层存储不同。

## 相关文档

- [Cloudflare 部署](/deployment/cloudflare) — Cloudflare 平台部署指南
- [Vercel 部署](/deployment/vercel) — 非 Cloudflare 平台部署
- [环境变量](/deployment/env) — 完整环境变量参考
