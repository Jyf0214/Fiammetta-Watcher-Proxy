# 部署指南

FWP 支持多种部署方式，可根据实际需求灵活选择。

## 部署方式对比

| 方式 | 适用场景 | 资源需求 | 难度 | 说明 |
|------|----------|----------|------|------|
| [Cloudflare Pages + Worker](/deployment/cloudflare) | **生产环境首选** | 免费额度内零成本 | ⭐ | Serverless 架构，自动扩缩容，全球 CDN |
| [Vercel / Netlify 等](/deployment/vercel) | Serverless 部署 | 免费额度内零成本 | ⭐⭐ | 利用 Pages API 处理 `/v1/*` 代理和 Cron |
| [Node.js 直接运行](/deployment/standalone) | 自有服务器、开发调试 | 1 vCPU / 512MB 起 | ⭐⭐ | 传统部署方式，完全可控 |
| [Docker](/deployment/docker) | 容器化部署 | 1 vCPU / 512MB 起 | ⭐ | 容器化部署，环境一致性好 |

## 架构模式

FWP 采用**双模式构建架构**，根据部署平台自动切换：

### Cloudflare 模式（`DEPLOY_PLATFORM=cf`）

```
用户请求 → Cloudflare Worker (/v1/* + Cron)
         → Cloudflare Pages (前端 + 管理 API)
```

- Worker 处理 `/v1/*` 代理请求和定时任务
- Pages 处理前端页面和管理后台 API
- 数据库使用 Cloudflare D1（通过 Binding 连接）

### 非 Cloudflare 模式（默认）

```
用户请求 → Pages API / Next.js Server (/v1/* 代理 + Cron + 管理 API)
         → 前端页面
```

- `/v1/*` 代理由 Pages API 路由处理（复用 Worker 业务模块）
- Cron 任务通过通用 HTTP 端点 `/api/cron/*` 暴露，由外部服务定时调用
- 数据库使用 TiDB / PostgreSQL（通过 `DATABASE_URL` 连接）

::: tip 建筑门控机制
构建时通过 `scripts/build-gate.sh` 自动处理：CF 构建时临时移除 `pages/api/v1/` 和 `pages/api/cron/`，构建完成后自动还原。详见 [架构说明](/deployment/architecture)。
:::

## 数据库选项

| 数据库 | DB_TYPE | 连接方式 | 适用场景 |
|--------|---------|----------|----------|
| Cloudflare D1 | `d1` | D1 Binding（无需 URL） | CF 部署首选，Serverless 原生 |
| TiDB Cloud | `tidb` | `DATABASE_URL`（MySQL 协议） | 免费 Serverless MySQL |
| PostgreSQL | `pg` | `DATABASE_URL` | 功能最全，适合自托管 |
| PostgreSQL via Hyperdrive | `pg` | Hyperdrive Connection String | CF 部署时的 PG 方案 |

::: warning 重要
`DB_TYPE` 是核心环境变量，决定了使用哪种 Prisma 适配器。必须与实际数据库匹配。
:::

## 资源需求

### Serverless 部署（CF / Vercel）

无服务器部署无需关心资源配额：
- Cloudflare Workers：免费计划 10ms CPU/请求
- Cloudflare Pages：免费计划无限请求
- Vercel：Hobby 计划 100GB 带宽/月

### 自托管部署

| 配置 | 最低 | 推荐 |
|------|------|------|
| CPU | 1 vCPU | 2 vCPU |
| 内存 | 512MB | 1GB+ |
| 磁盘 | 10GB | 20GB |
| Node.js | 18.0 | 22.x LTS |

## 下一步

- [Cloudflare 部署](/deployment/cloudflare) — 推荐的 Serverless 部署方案
- [Vercel 部署](/deployment/vercel) — 非 Cloudflare 平台部署
- [架构说明](/deployment/architecture) — 双模式构建架构详解
- [Node.js 直接部署](/deployment/standalone) — 自托管完整指南
- [Docker 部署](/deployment/docker) — 容器化部署
- [环境变量](/deployment/env) — 完整环境变量参考
- [Nginx 配置](/deployment/nginx) — 反向代理和 HTTPS
