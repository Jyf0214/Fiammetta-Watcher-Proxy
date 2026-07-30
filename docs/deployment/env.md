# 环境变量

所有环境变量在 `.env` 文件中配置（自托管）或在平台控制台中配置（Serverless）。

## 核心配置

| 变量 | 说明 | 必填 | 默认值 |
|------|------|------|--------|
| `DB_TYPE` | 数据库类型：`d1` / `tidb` / `pg` | 是 | — |
| `DATABASE_URL` | 数据库连接字符串（`d1` 模式无需设置） | `tidb`/`pg` 模式必须 | — |
| `ADMIN_USERNAME` | 管理员用户名 | 是 | `admin` |
| `ADMIN_PASSWORD` | 管理员密码 | 是 | — |
| `JWT_SECRET` | JWT 签名密钥（留空自动生成） | 否 | 自动生成 |

::: warning 重要
- `DB_TYPE` 是核心环境变量，决定了使用哪种 Prisma 适配器。必须与实际数据库匹配。
- `DB_TYPE=d1` 时无需 `DATABASE_URL`，D1 通过 Cloudflare Binding 连接。
- `ADMIN_PASSWORD` 必须设置，系统启动时会自动创建管理员账户。
:::

## 数据库配置

### DB_TYPE 说明

| 值 | 数据库 | 连接方式 | 适用场景 |
|-----|--------|----------|----------|
| `d1` | Cloudflare D1 | D1 Binding（无需 URL） | Cloudflare 部署首选 |
| `tidb` | TiDB Cloud | `DATABASE_URL`（MySQL 协议） | 免费 Serverless MySQL |
| `pg` | PostgreSQL | `DATABASE_URL` | 功能最全，自托管首选 |

### DATABASE_URL 格式

**TiDB Cloud / MySQL**：

```env
DB_TYPE=tidb
DATABASE_URL=mysql://用户名:密码@gateway01.xxxx.prod.aws.tidbcloud.com:4000/dbname?sslaccept=accept_invalid_certs
```

**PostgreSQL**：

```env
DB_TYPE=pg
DATABASE_URL=postgresql://用户名:密码@主机:端口/数据库名
```

**Cloudflare D1**：

```env
DB_TYPE=d1
# 无需 DATABASE_URL，通过 Cloudflare Binding 自动连接
```

### 连接池参数

在内存小于 1GB 的环境中，建议在 `DATABASE_URL` 末尾添加：

```
?connection_limit=5&pool_timeout=10
```

## 安全配置

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `JWT_SECRET` | JWT 签名密钥（HS256 模式） | 自动生成 |
| `JWKS_KEY` | JWKS/JWK/PEM 格式密钥（RS256 非对称加密，与 `JWT_SECRET` 二选一） | — |
| `ADMIN_USERNAME` | 管理员用户名 | `admin` |
| `ADMIN_PASSWORD` | 管理员密码 | —（必须设置） |

::: tip
`JWT_SECRET` 和 `JWKS_KEY` 至少配置其中一个。`JWT_SECRET` 使用对称加密（HS256），适合大多数场景；`JWKS_KEY` 使用非对称加密（RS256），适合企业级安全需求，支持 JWKS、JWK、PEM 三种格式自动识别。
:::

## 服务配置

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务监听端口 | `3000` |
| `NODE_ENV` | 运行环境 | `production` |

## Cron 配置

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `CRON_SECRET` | 定时任务认证密钥（Bearer Token） | —（未设置则跳过认证） |

::: tip
`CRON_SECRET` 用于保护 `/api/cron/*` 端点。设置后，所有 cron 请求必须携带 `Authorization: Bearer <CRON_SECRET>` 头。
:::

## 通知配置（可选）

| 变量 | 说明 |
|------|------|
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token，用于发送系统告警通知 |
| `TELEGRAM_CHAT_ID` | Telegram Chat ID，指定通知接收群组 |
| `SMTP_HOST` | SMTP 服务器地址 |
| `SMTP_PORT` | SMTP 服务器端口 |
| `SMTP_USER` | SMTP 用户名 |
| `SMTP_PASS` | SMTP 密码 |
| `SMTP_FROM` | 发件人邮箱地址 |

## 按部署方式的配置示例

### Cloudflare 部署

Worker 环境变量（在 Cloudflare Dashboard 中配置）：

```env
DB_TYPE=d1
ADMIN_USERNAME=admin
ADMIN_PASSWORD=secure-password
CRON_SECRET=random-secret
```

Pages 环境变量（在 Cloudflare Dashboard 中配置）：

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=secure-password
```

### Vercel / Netlify 部署

```env
DB_TYPE=tidb
DATABASE_URL=mysql://user:password@host:4000/dbname?sslaccept=accept_invalid_certs
ADMIN_USERNAME=admin
ADMIN_PASSWORD=secure-password
JWT_SECRET=
CRON_SECRET=random-secret
```

### 自托管部署

```env
# ===== 数据库配置 =====
DB_TYPE=pg
DATABASE_URL=postgresql://fwp:password@localhost:5432/fwp

# ===== 安全配置 =====
ADMIN_USERNAME=admin
ADMIN_PASSWORD=secure-password
JWT_SECRET=

# ===== 服务配置 =====
PORT=3000
NODE_ENV=production

# ===== Cron 认证（可选） =====
CRON_SECRET=random-secret

# ===== 通知配置（可选） =====
# TELEGRAM_BOT_TOKEN=123456:ABC-DEF
# TELEGRAM_CHAT_ID=-100123456
# SMTP_HOST=smtp.example.com
# SMTP_PORT=587
# SMTP_USER=user@example.com
# SMTP_PASS=your-smtp-password
# SMTP_FROM=noreply@example.com
```

## 相关文档

- [Cloudflare 部署](/deployment/cloudflare) — Cloudflare 平台环境变量配置
- [Vercel 部署](/deployment/vercel) — Vercel 平台环境变量配置
- [Node.js 直接部署](/deployment/standalone) — 自托管环境变量配置
