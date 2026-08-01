# Fiammetta Watcher Proxy

[English](README_EN.md) | 简体中文

> [!TIP]
> **注意：项目处于开发阶段，功能不稳定，暂不建议用于生产环境。如需使用，请切换到 `stable` 分支，通过 Docker 方式部署。**

LLM API 中转站，支持多平台负载均衡、熔断恢复、SSE 流式响应。部署在 Cloudflare 全球边缘网络。

**部署教程请见：[https://jyf0214.github.io/Fiammetta-Watcher-Proxy/](https://jyf0214.github.io/Fiammetta-Watcher-Proxy/)**

## 功能特性

- **多平台负载均衡** — 多上游 API 平台，按优先级、权重、健康状态自动路由
- **熔断恢复** — 平台故障自动熔断，恢复后自动切回
- **SSE 流式响应** — 完整支持主流 LLM 平台的流式响应格式
- **管理后台** — 平台、密钥、模型映射、日志、审计的可视化管理
- **定时任务** — Key 用量自动重置、平台模型自动发现、日志自动归档
- **多数据库支持** — D1 / TiDB Cloud / MariaDB / PostgreSQL，运行时自动切换

## 架构

```
用户请求 → Cloudflare Worker（代理 v1/* + Cron 任务）
         → Cloudflare Pages（管理后台 + API 路由）
         → D1 / TiDB / MariaDB / PostgreSQL（通过 lib/prisma.ts 统一工厂）
         → KV 命名空间（登录限流 + 熔断状态）
```

## 数据库支持

通过 `DB_TYPE` 环境变量选择数据库，`lib/prisma.ts` 统一工厂自动切换适配器：

| DB_TYPE | 数据库 | 适配器 | 协议 | 平台 |
|---------|--------|--------|------|------|
| `d1`（默认） | Cloudflare D1 | `@prisma/adapter-d1` | D1 Binding | CF |
| `tidb` | TiDB Cloud Serverless | `@tidbcloud/prisma-adapter` | HTTP | 所有平台 |
| `mariadb` | MariaDB / 纯 MySQL | `@prisma/adapter-mariadb` | TCP | 仅非 CF（EdgeOne/Vercel/纯 Node） |
| `pg` | PostgreSQL 直连 | `@prisma/adapter-pg` | TCP | 所有平台 |

> **TiDB 注意事项：** TiDB Cloud 在 Cloudflare Workers 中必须使用 HTTP 协议（`@tidbcloud/prisma-adapter`），不能使用传统 TCP 连接的 `@prisma/adapter-mariadb`，因为 Workers 运行在 V8 Isolate 上不支持 Node.js TCP Socket。`mariadb` 驱动走 TCP，仅适用于 MariaDB/纯 MySQL 直连，且**仅支持非 CF 平台**（CF 构建会将 mariadb 驱动排除在产物外）。免费版 Workers 存在 CPU/请求限制，批量导入日志（多条记录写入）时 API 可能超时不可用。

## 部署

### 方式一：GitHub Actions 自动部署（推荐）

推送到 `canary` 分支自动触发 Cloudflare 部署；EdgeOne 部署仅支持手动触发（需配置 `EO_PROJECT_NAME` / `EO_API_TOKEN` secrets）；也可在 Actions 页面手动选择部署平台（cf / edgeone / both）。工作流步骤：

1. **初始化资源（pre）** — `deploy/init.py pre` 创建 D1/KV + 替换配置占位符 + 写入 DB_TYPE
2. **安装依赖** — `npm install` + 按 DB_TYPE 生成对应方言 Prisma Client
3. **校验配置** — `deploy/init.py check` 验证 Schema 文件和生成产物
4. **构建** — `npm run build:cf`（OpenNext 构建 + 产物整理）
5. **部署 Worker** — `wrangler deploy`（API 代理 + Cron）
6. **初始化绑定和 Secrets（post）** — `deploy/init.py post` 创建 Pages + 绑定 + 设置所有 Secrets
7. **部署 Pages** — `wrangler pages deploy .open-next`（管理后台）

    需要在 GitHub 仓库 Settings → Secrets 中配置：

| Secret | 说明 |
|--------|------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token（Edit 权限） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账户 ID |
| `ADMIN_USERNAME` | 管理员用户名 |
| `ADMIN_PASSWORD` | 管理员密码 |
| `DB_TYPE` | 数据库类型（`d1` / `tidb` / `pg`，默认 `d1`） |
| `DATABASE_URL` | 外部数据库 URL（TiDB/PG 时必需，D1 无需设置） |
| `EO_PROJECT_NAME` | EdgeOne Makers 项目名（EdgeOne 部署时需要） |
| `EO_API_TOKEN` | EdgeOne API Token（EdgeOne 部署时需要） |

### 方式二：手动部署

#### 前置条件

- Node.js 22+
- Python 3.12+
- Cloudflare 账号 + API Token

#### 步骤

```bash
# 1. 安装依赖
npm install

# 2. 登录 Wrangler（或设置 CLOUDFLARE_API_TOKEN 环境变量）
npx wrangler login

# 3. 初始化资源（创建 D1/KV + 替换配置占位符 + 写入 DB_TYPE）
python3 deploy/init.py pre

# 4. 校验 Prisma 多方言配置
python3 deploy/init.py check

# 5. 构建
npm run build:cf

# 6. 部署 Worker
cd worker && npx wrangler deploy && cd ..

# 7. 初始化绑定和 Secrets（Pages 绑定 + 所有 Secrets）
python3 deploy/init.py post

# 8. 部署 Pages
npx wrangler pages deploy .open-next --project-name fiammetta-watcher --branch main
```

### 环境变量

| 变量 | 说明 |
|------|------|
| `ADMIN_USERNAME` | 管理员用户名 |
| `ADMIN_PASSWORD` | 管理员密码 |
| `JWT_SECRET` | JWT 签名密钥（至少 32 字符；Cloudflare CI 部署时自动生成，其他平台必须手动设置） |
| `DB_TYPE` | 数据库类型：`d1`（默认）/ `tidb` / `pg`（CF 部署）；`mariadb` 仅非 CF 平台可用 |
| `DATABASE_URL` | 外部数据库 URL（TiDB/MariaDB/PG 时必需，D1 通过 binding 连接无需设置） |

## 开发

```bash
npm run dev          # 本地开发
npm run build        # Next.js 构建
npm run build:cf     # Cloudflare 构建
npm run preview      # Cloudflare 本地预览
npm run test         # 运行测试
```

## 技术栈

- **运行时**: Cloudflare Workers + Pages（OpenNext）
- **框架**: Next.js 16 + React 19
- **数据库**: Cloudflare D1 / TiDB Cloud / MariaDB / PostgreSQL（Prisma 7 ORM + Driver Adapters）
- **缓存**: Cloudflare KV
- **UI**: Ant Design 6 + Tailwind CSS
- **图表**: Recharts
- **认证**: JWT（jose）

## 许可证

[Apache License 2.0](LICENSE)

## 免责声明

本项目为独立开发的开源软件，与任何大语言模型服务提供商（包括但不限于 OpenAI、Anthropic、Google 等）无任何关联、赞助或授权关系。

本项目仅提供 API 请求转发功能，不对通过本项目转发的任何请求内容、响应内容或使用行为承担法律责任。使用者应自行确保其使用方式符合所连接平台的服务条款及相关法律法规。

本项目按「现状」提供，不作任何明示或暗示的保证。作者不对因使用本项目而产生的任何直接或间接损失承担责任。
