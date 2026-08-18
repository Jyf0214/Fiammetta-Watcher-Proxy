# 部署指南

FWP 支持 5 种部署方式（Cloudflare / Vercel / EdgeOne / Node.js / Docker），按部署目标分组（Vercel 与 EdgeOne 架构相同，合并为一行）：

| 方式 | 架构 | 数据库 | 定时任务 |
|------|------|--------|----------|
| **Cloudflare Pages + Worker** | Worker 处理代理与定时任务，Pages 托管前台与管理后台 | D1（免费，零配置）或 TiDB/PostgreSQL | Cloudflare 内置（免费） |
| **Vercel / EdgeOne** | 服务端函数处理一切 | TiDB / MySQL / MariaDB / PostgreSQL（远程） | HTTP 端点 + 外部调度（Vercel Cron 需 Pro 计划） |
| **Node.js 直接部署** | 自有服务器跑完整服务 | TiDB / MySQL / MariaDB / PostgreSQL | HTTP 端点 + 系统 cron |
| **Docker** | 容器化部署 | TiDB / MySQL / MariaDB / PostgreSQL | 容器内部定时器自动执行 |

## 平台对比

| 项目 | Cloudflare | Vercel | EdgeOne | Node.js / Docker |
|------|-----------|--------|---------|------------------|
| 免费额度 | Worker CPU 10ms/请求（代理流式请求容易超限） | 100GB 流量/月 | 见官方定价 | 无（自备资源） |
| 定时任务 | 内置（免费） | **仅 Pro 计划** | 外部调度 | 系统 cron（Node.js）/ Docker 内置自动 |
| 数据库 | D1（默认，零配置） | TiDB/MySQL/MariaDB/PostgreSQL（远程） | TiDB/MySQL/MariaDB/PostgreSQL（远程） | TiDB/MySQL/MariaDB/PostgreSQL |
| 部署触发 | 网页手动触发，或推 `canary` 分支 | 控制台关联 Git 仓库 | 网页手动触发 | 手动 |
| 适合 | 零成本 Serverless | 已有 Vercel / TiDB 账号 | 腾讯云生态 | 完全掌控 |

> **免费版注意**：Cloudflare Workers 免费版单请求 CPU 上限 10ms，代理 AI 流式请求容易超限导致失败；生产建议升级 Workers Paid（CPU 上限默认 30s，最高 5 分钟）或选择其他平台。

## 如何选择

1. **想要零成本 Serverless** → [Cloudflare 部署](/deployment/cloudflare)（D1 数据库免费）
2. **已有 Vercel 项目或 TiDB Cloud** → [Vercel 部署](/deployment/vercel)
3. **腾讯云用户 / 需要国内加速** → [EdgeOne 部署](/deployment/edgeone)（新平台，首次部署请人工验证）
4. **自有服务器 / VPS / 内网** → [Node.js 直接部署](/deployment/standalone) 或 [Docker 部署](/deployment/docker)
5. **只想查环境变量** → [环境变量](/deployment/env)

> 部署全程在 GitHub 网页完成：手动运行工作流并选择目标平台即可，无需配置任何部署模式。

## 数据库选择

| 数据库 | 需要设置 | 适用平台 |
|--------|----------|----------|
| Cloudflare D1 | 无需配置（`DB_TYPE=d1`） | 仅 Cloudflare |
| TiDB Cloud | `DB_TYPE=tidb` + `DATABASE_URL`（MySQL 协议） | 所有平台 |
| 纯 MySQL | `DB_TYPE=mysql` + `DATABASE_URL`（`mysql://`） | 非 Cloudflare 平台（Vercel / EdgeOne / Node.js / Docker） |
| MariaDB | `DB_TYPE=mariadb` + `DATABASE_URL`（mariadb 协议） | 非 Cloudflare 平台（Vercel / EdgeOne / Node.js / Docker） |
| PostgreSQL | `DB_TYPE=pg` + `DATABASE_URL` | 所有平台 |

## 相关文档

- [快速开始](/guide/quickstart) — 本地安装与初始化
- [API 参考](/api/) — 各端点调用方式
- [架构说明](/deployment/architecture) — 了解两种部署模式与平台差异
- [环境变量](/deployment/env)
- [Nginx 配置](/deployment/nginx) — 自托管反向代理
