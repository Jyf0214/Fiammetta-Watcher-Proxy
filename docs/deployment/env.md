# 环境变量

所有环境变量在 `.env` 文件中配置。

## 必需配置

| 变量 | 说明 | 示例 |
|------|------|------|
| `DATABASE_URL` | 数据库连接字符串 | 见下方数据库配置 |
| `JWT_SECRET` | JWT 签名密钥（HS256 模式，至少 32 字节） | `openssl rand -base64 32` 生成 |
| `ADMIN_USERNAME` | 初始管理员用户名 | `admin` |
| `ADMIN_PASSWORD` | 初始管理员密码 | `your-strong-password` |

::: warning
缺少 `JWT_SECRET` 或 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 时，系统无法启动。
缺少 `DATABASE_URL` 时，系统允许启动并引导到 `/setup` 页面进行网页配置。
:::

## 数据库配置

| 变量 | 说明 | 格式 |
|------|------|------|
| `DATABASE_URL` | 数据库连接字符串 | 见下方示例 |

### PostgreSQL

```env
DATABASE_URL=postgresql://用户名:密码@主机:端口/数据库名?connection_limit=5&pool_timeout=10
```

### MySQL

```env
DATABASE_URL=mysql://用户名:密码@主机:端口/数据库名?connection_limit=5&pool_timeout=10
```

### TiDB Cloud

```env
DATABASE_URL=mysql://用户名:密码@gateway01.xxxx.prod.aws.tidbcloud.com:4000/dbname?connection_limit=5&pool_timeout=10&sslaccept=accept_invalid_certs
```

### 连接池参数

FWP 建议在 `DATABASE_URL` 中添加以下参数（适用于小内存环境）：

- `connection_limit=5` — 最大连接数
- `pool_timeout=10` — 连接池超时（秒）

## 安全配置

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `JWT_SECRET` | JWT 签名密钥（HS256 模式） | —（必须设置，或设置 `JWKS_KEY`） |
| `JWKS_KEY` | JWKS/JWK/PEM 格式密钥（RS256 非对称加密，与 `JWT_SECRET` 二选一） | — |
| `ADMIN_USERNAME` | 管理员用户名 | `admin` |
| `ADMIN_PASSWORD` | 管理员密码 | —（必须设置） |

::: tip
`JWT_SECRET` 和 `JWKS_KEY` 至少需要配置其中一个。`JWT_SECRET` 使用对称加密（HS256），适合大多数场景；`JWKS_KEY` 使用非对称加密（RS256），适合企业级安全需求，支持 JWKS、JWK、PEM 三种格式自动识别。
:::

## 服务配置

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务监听端口 | `3000` |
| `NODE_ENV` | 运行环境 | `production` |

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

## 完整示例

```env
# ===== 数据库配置 =====
DATABASE_URL=postgresql://fwp:password@localhost:5432/fwp

# ===== 安全配置 =====
JWT_SECRET=my-super-secret-key-change-this
ADMIN_USERNAME=admin
ADMIN_PASSWORD=secure-password-here

# ===== 服务配置 =====
PORT=3000
NODE_ENV=production

# ===== 通知配置（可选） =====
# TELEGRAM_BOT_TOKEN=123456:ABC-DEF
# TELEGRAM_CHAT_ID=-100123456
# SMTP_HOST=smtp.example.com
# SMTP_PORT=587
# SMTP_USER=user@example.com
# SMTP_PASS=your-smtp-password
# SMTP_FROM=noreply@example.com
```
