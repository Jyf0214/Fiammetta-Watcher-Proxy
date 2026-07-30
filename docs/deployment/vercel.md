# Vercel / 非 Cloudflare 平台部署

FWP 支持部署到 Vercel、Netlify 或任何支持 Node.js 的 Serverless 平台。非 Cloudflare 模式下，Pages API 自身处理 `/v1/*` 代理请求和 Cron 定时任务，无需 Worker。

## 与 Cloudflare 部署的区别

| 功能 | Cloudflare 模式 | 非 Cloudflare 模式 |
|------|-----------------|------------|
| `/v1/*` 代理 | Worker 处理 | Pages API 处理 |
| Cron 定时任务 | Worker Cron Triggers | HTTP 端点 + 外部调度 |
| 速率限制 | KV 持久化 | 内存 Map（冷启动后重置） |
| 数据库 | D1 (Binding) | TiDB / PostgreSQL (`DATABASE_URL`) |
| 流式响应 | Worker 原生支持 | Node.js ReadableStream |

::: tip 关键差异
非 Cloudflare 模式的速率限制使用内存存储，每次冷启动后计数器重置。对于大多数场景这是可接受的（限流是尽力而为的）。
:::

## 前置条件

1. [Vercel 账号](https://vercel.com/signup)（免费即可）
2. [TiDB Cloud](https://tidbcloud.com/) 或 PostgreSQL 数据库
3. 项目的 GitHub 仓库

## 方式一：Vercel 部署

### 1. 导入项目

1. 登录 [Vercel Dashboard](https://vercel.com/dashboard)
2. 点击「Add New → Project」
3. 从 GitHub 导入 FWP 仓库
4. 框架预设选择 **Next.js**
5. 构建命令设置为 `npm run build`
6. 输出目录设置为 `.next`

### 2. 配置环境变量

在 Vercel 项目的 Settings → Environment Variables 中添加：

```env
# 数据库（必须）
DB_TYPE=tidb
DATABASE_URL=mysql://用户名:密码@host:4000/dbname?sslaccept=accept_invalid_certs

# 安全配置（必须）
ADMIN_USERNAME=admin
ADMIN_PASSWORD=你的管理员密码

# JWT 密钥（留空自动生成，或手动指定）
JWT_SECRET=

# Cron 认证密钥（可选，用于 /api/cron/* 端点）
CRON_SECRET=随机生成的密钥字符串
```

::: warning 重要
- `DB_TYPE` 必须设置为 `tidb` 或 `pg`（不能是 `d1`，因为没有 D1 Binding）
- `DATABASE_URL` 必须是可从 Vercel 的 Serverless 函数访问的远程数据库地址
- Vercel 的 Serverless 函数是无状态的，数据库需要支持远程连接
:::

### 3. 部署

Vercel 会自动检测 `next.config.ts` 并触发构建部署。推送代码即可自动部署。

### 4. 配置 Cron 任务

Vercel Hobby 计划支持 Cron 功能。在项目根目录创建 `vercel.json`：

```json
{
  "crons": [
    {
      "path": "/api/cron/model-fetch",
      "schedule": "*/10 * * * *"
    },
    {
      "path": "/api/cron/key-reset",
      "schedule": "0 0 * * *"
    },
    {
      "path": "/api/cron/log-archive",
      "schedule": "0 1 * * *"
    }
  ]
}
```

::: tip Vercel Cron 认证
Vercel Cron 会自动在请求头中添加 `Authorization: Bearer <CRON_SECRET>`。在 Vercel 环境变量中设置 `CRON_SECRET` 以启用认证。也可以使用外部服务调用这些端点。
:::

如果没有 Vercel Cron，可以使用外部服务（如 [Cron-job.org](https://cron-job.org)、[UptimeRobot](https://uptimerobot.com)）定时调用：

```bash
curl -X GET https://你的域名/api/cron/model-fetch \
  -H "Authorization: Bearer 你的CRON_SECRET"
```

## 方式二：Netlify 部署

### 1. 导入项目

1. 登录 [Netlify Dashboard](https://app.netlify.com)
2. 点击「Add new site → Import an existing project」
3. 从 GitHub 导入

### 2. 构建配置

| 设置 | 值 |
|------|-----|
| Build command | `npm run build` |
| Publish directory | `.next` |
| Node.js version | 22 |

### 3. 环境变量

与 Vercel 相同，在 Netlify 项目 Settings → Environment variables 中配置。

### 4. Cron 任务

Netlify 支持通过 [Scheduled Functions](https://docs.netlify.com/functions/scheduled-functions/) 配置定时任务，或使用外部 cron 服务调用 `/api/cron/*` 端点。

## 方式三：其他 Node.js 平台

FWP 的非 Cloudflare 模式可以在任何支持 Node.js 的平台上运行。通用步骤：

### 1. 构建

```bash
npm install
npm run build
```

### 2. 设置环境变量

```env
DB_TYPE=tidb  # 或 pg
DATABASE_URL=你的数据库连接字符串
ADMIN_USERNAME=admin
ADMIN_PASSWORD=你的密码
```

### 3. 启动

```bash
npm start
```

### 4. 配置 Cron

通过外部服务定时调用 `/api/cron/*` 端点：

| 端点 | 功能 | 建议频率 |
|------|------|----------|
| `GET /api/cron/model-fetch` | 模型发现 | 每 10 分钟 |
| `GET /api/cron/key-reset` | Key 重置 | 每天 |
| `GET /api/cron/log-archive` | 日志归档 | 每天 |

推荐的外部 Cron 服务：

- [Cron-job.org](https://cron-job.org) — 免费，支持 HTTP 调用
- [UptimeRobot](https://uptimerobot.com) — 免费，主要用于监控但可做定时调用
- [GitHub Actions](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#schedule) — 在 `main` 分支使用 `schedule` 触发器

**GitHub Actions Cron 示例**：

```yaml
# .github/workflows/cron.yml
name: Cron Tasks
on:
  schedule:
    - cron: '*/10 * * * *'  # 每 10 分钟
  workflow_dispatch:  # 支持手动触发

jobs:
  model-fetch:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger Model Fetch
        run: |
          curl -X GET "${{ secrets.APP_URL }}/api/cron/model-fetch" \
            -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}"
```

## 数据库选择

非 Cloudflare 模式支持以下数据库：

### TiDB Cloud（推荐免费方案）

1. 注册 [TiDB Cloud](https://tidbcloud.com/)
2. 创建 Serverless 集群（免费额度：500MB 存储 + 50M RCUs 读取）
3. 获取连接字符串：
   ```
   mysql://用户名:密码@gateway01.xxxx.prod.aws.tidbcloud.com:4000/dbname?sslaccept=accept_invalid_certs
   ```

### PostgreSQL

任何可远程访问的 PostgreSQL 数据库均可：

- [Neon](https://neon.tech) — 免费 512MB
- [Supabase](https://supabase.com) — 免费 500MB
- [Railway](https://railway.app) — 免费额度
- 自建 PostgreSQL

```env
DB_TYPE=pg
DATABASE_URL=postgresql://用户:密码@主机:端口/数据库名
```

## 常见问题

### 速率限制在冷启动后重置

这是预期行为。非 Cloudflare 模式的速率限制使用内存 Map 存储，Serverless 函数冷启动后计数器清空。限流是尽力而为的，不影响核心功能。

### 流式响应不工作

确认平台支持 Node.js 的 `ReadableStream`。Vercel 和 Netlify 都支持，但某些平台可能不支持 Server-Sent Events。

### 数据库连接超时

Serverless 环境中数据库连接是短暂的：

- 确保数据库允许远程连接
- 检查防火墙/白名单是否放行了 Vercel/Netlify 的 IP
- TiDB Cloud 天然支持远程连接，无需配置

### `/api/cron/*` 返回 401

如果配置了 `CRON_SECRET`，请求必须携带 `Authorization: Bearer <CRON_SECRET>` 头。如果未配置 `CRON_SECRET`，端点无需认证。

## 相关文档

- [架构说明](/deployment/architecture) — 双模式构建架构详解
- [环境变量](/deployment/env) — 完整环境变量参考
- [Nginx 配置](/deployment/nginx) — 反向代理和 HTTPS（自托管场景）
