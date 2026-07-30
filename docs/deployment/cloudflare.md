# Cloudflare 部署

FWP 的原生部署平台。使用 Cloudflare Pages 托管前端和管理 API，Cloudflare Worker 处理 `/v1/*` 代理和定时任务，D1 作为数据库。全球边缘节点，零运维成本。

## 架构概览

```
┌─────────────────────────────────────────────┐
│              Cloudflare Edge                │
│                                             │
│  ┌──────────────┐  ┌──────────────────────┐ │
│  │   Worker     │  │      Pages           │ │
│  │              │  │                      │ │
│  │ /v1/* 代理   │  │ 前端 (React/Next.js) │ │
│  │ Cron 定时任务 │  │ /api/admin/* 管理API │ │
│  │              │  │ /api/setup/* 初始化   │ │
│  └──────┬───────┘  └──────────┬───────────┘ │
│         │                     │             │
│         └─────────┬───────────┘             │
│                   ▼                         │
│          ┌──────────────┐                   │
│          │   D1 数据库   │                   │
│          │  (SQLite)    │                   │
│          └──────────────┘                   │
└─────────────────────────────────────────────┘
```

- **Worker**：处理 `/v1/*` 代理请求（API Key 验证 → 路由 → 转发 → 流式响应）和 Cron 定时任务（模型发现、Key 重置、日志归档）
- **Pages**：托管前端静态资源和管理后台 API（平台管理、Key 管理、用量监控等）
- **D1**：Cloudflare 原生 SQLite 数据库，通过 Binding 连接，无需 `DATABASE_URL`

## 前置条件

1. [Cloudflare 账号](https://dash.cloudflare.com/sign-up)（免费即可）
2. [GitHub 账号](https://github.com)
3. 项目的 GitHub 仓库 fork 到你的账号下

## 方式一：GitHub Actions 自动部署（推荐）

### 1. 创建 Cloudflare 资源

项目提供了自动化脚本，一键创建所需的所有 Cloudflare 资源：

```bash
# 克隆项目
git clone https://github.com/你的用户名/Fiammetta-Watcher-Proxy.git
cd Fiammetta-Watcher-Proxy

# 获取 Cloudflare API Token
# 访问 https://dash.cloudflare.com/profile/api-tokens
# 创建 Token，权限需要：Account > Cloudflare Workers > Edit, D1 > Edit, Pages > Edit

# 安装 Python（脚本需要）
pip install -r deploy/requirements.txt

# 运行初始化脚本（创建 D1 数据库、KV 命名空间、Worker、Pages 项目）
export CLOUDFLARE_API_TOKEN="你的API-Token"
export CLOUDFLARE_ACCOUNT_ID="你的账号ID"
python deploy/init.py
```

`init.py` 执行三个阶段：

1. **pre-check**：检查账号权限和现有资源
2. **create**：创建 D1 数据库、KV 命名空间、Worker、Pages 项目，配置绑定
3. **post-check**：验证资源创建成功

### 2. 配置 GitHub Secrets

在 GitHub 仓库的 Settings → Secrets and variables → Actions 中添加：

| Secret 名称 | 说明 | 来源 |
|-------------|------|------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token | [Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号 ID | [Cloudflare Dashboard](https://dash.cloudflare.com/) 右侧栏 |
| `CF_D1_DATABASE_ID` | D1 数据库 ID | init.py 输出 |
| `CF_KV_NAMESPACE_ID` | KV 命名空间 ID | init.py 输出 |

::: tip
`init.py` 执行完成后会在终端输出所有需要的 ID，直接复制到 GitHub Secrets 即可。
:::

### 3. 配置环境变量

在 Cloudflare Dashboard → Workers & Pages → 你的 Worker → Settings → Variables 中设置：

| 变量名 | 值 | 类型 |
|--------|-----|------|
| `ADMIN_USERNAME` | 管理员用户名 | Text |
| `ADMIN_PASSWORD` | 管理员密码 | Text (Encrypted) |
| `CRON_SECRET` | 定时任务认证密钥（可选） | Text (Encrypted) |

::: warning
Worker 的环境变量需要在 Cloudflare Dashboard 中配置，不是 GitHub Secrets。D1 绑定在 `init.py` 中自动配置。
:::

### 4. 触发部署

推送代码到 `main` 分支即可自动触发部署：

```bash
git push origin main
```

部署流程：

1. `build:cf` — Cloudflare 模式构建（临时移除 v1/cron 路由 → OpenNext 构建 → 还原路由）
2. Worker 部署到 Cloudflare Workers
3. Pages 部署到 Cloudflare Pages
4. D1 数据库 Schema 自动迁移

### 5. 验证部署

```bash
# 检查 Worker 健康
curl https://你的-worker子域名.workers.dev/v1/models

# 检查 Pages 管理后台
curl https://你的-pages子域名.pages.dev/api/health
```

## 方式二：Wrangler 手动部署

适合开发调试或自定义部署流程。

### 1. 安装 Wrangler

```bash
npm install -g wrangler
wrangler login
```

### 2. 创建资源

```bash
# 创建 D1 数据库
wrangler d1 create fiammetta-watcher-db
# 记下输出的 database_id，更新到 wrangler.toml

# 创建 KV 命名空间
wrangler kv namespace create CACHE
wrangler kv namespace create CACHE --preview
# 记下输出的 id，更新到 wrangler.toml
```

### 3. 配置 wrangler.toml

打开 `worker/wrangler.toml`，更新以下配置：

```toml
name = "fwp-worker"
main = "worker/src/index.ts"
compatibility_date = "2024-01-01"

# D1 数据库绑定
[[d1_databases]]
binding = "DB"
database_name = "fiammetta-watcher-db"
database_id = "你的-database-id"

# KV 命名空间绑定
[[kv_namespaces]]
binding = "CACHE"
id = "你的-kv-namespace-id"

[vars]
DB_TYPE = "d1"
```

### 4. 初始化数据库

```bash
npx wrangler d1 execute fiammetta-watcher-db --file=./migrations/0001_init_schema.sql
```

### 5. 部署 Worker

```bash
cd worker
wrangler deploy
```

### 6. 部署 Pages

```bash
# Cloudflare 模式构建
CF_DEPLOY=true npm run build:cf

# 部署到 Pages
npx wrangler pages deploy .open-next/assets --project-name=你的-pages项目名
```

## 定时任务配置

FWP 有 3 个定时任务：

| 任务 | 路径 | 默认频率 | 功能 |
|------|------|----------|------|
| 模型发现 | `model-fetch` | 每 10 分钟 | 自动发现各平台支持的模型 |
| Key 重置 | `key-reset` | 每天 | 重置 Key 用量计数器 |
| 日志归档 | `log-archive` | 每天 | 归档过期请求日志为统计数据 |

在 `worker/wrangler.toml` 中配置 Cron Triggers：

```toml
[triggers]
crons = ["*/10 * * * *", "0 0 * * *", "0 1 * * *"]
```

或在 Cloudflare Dashboard → Worker → Settings → Triggers → Cron Triggers 中配置。

## 常见问题

### 构建失败：OpenNext 报错

检查 `package.json` 中的 `build:cf` 命令是否完整：

```json
{
  "scripts": {
    "build:cf": "CF_DEPLOY=true bash scripts/build-gate.sh && node scripts/prepare-db.mjs && opennextjs-cloudflare build && CF_DEPLOY=true bash scripts/build-gate-restore.sh"
  }
}
```

### Worker CPU 超时

Cloudflare Workers Free 计划 CPU 限制 10ms/请求。如果经常超时：

- 检查是否有不必要的同步计算
- 确认没有调用 `prisma.$disconnect()`（会破坏连接缓存导致 CPU 飙升）
- 考虑升级到 Workers Paid 计划（50ms CPU/请求）

### D1 连接问题

确保：

- `wrangler.toml` 中的 `database_id` 正确
- Worker 环境变量 `DB_TYPE = "d1"`
- 没有使用 `DATABASE_URL`（D1 通过 Binding 连接，不需要 URL）

### 流式响应中断

如果 SSE 流式响应经常中断，检查：

- Cloudflare Workers 的 `ctx.waitUntil()` 是否正确保护了异步写入
- 请求超时设置（默认 120 秒）

## 相关文档

- [架构说明](/deployment/architecture) — 双模式构建架构详解
- [环境变量](/deployment/env) — 完整环境变量参考
- [Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/)
