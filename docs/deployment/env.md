# 环境变量

所有环境变量都在 `.env` 文件中配置。

## 必需配置

| 变量 | 说明 | 示例 |
|------|------|------|
| `DATABASE_URL` | 数据库连接字符串 | `postgresql://user:pass@localhost:5432/fwp` |
| `JWT_SECRET` | JWT 签名密钥（必须修改） | `your-super-secret-key` |
| `ADMIN_USERNAME` | 初始管理员用户名 | `admin` |
| `ADMIN_PASSWORD` | 初始管理员密码 | `your-password` |

## 数据库配置

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DATABASE_URL` | 数据库连接字符串 | — |

### 连接池优化

FWP 自动添加以下参数到数据库连接字符串：

- `connection_limit=5` — 最大连接数
- `pool_timeout=10` — 连接池超时（秒）

适用于小内存环境（1GB 以下）。

## 安全配置

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `JWT_SECRET` | JWT 签名密钥 | —（必须设置） |
| `ADMIN_USERNAME` | 管理员用户名 | `admin` |
| `ADMIN_PASSWORD` | 管理员密码 | —（首次启动时设置） |

## 通知配置（可选）

| 变量 | 说明 |
|------|------|
| `WEBHOOK_URL` | Webhook 通知地址 |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token |
| `TELEGRAM_CHAT_ID` | Telegram Chat ID |

## 部署配置

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务监听端口 | `3000` |
| `NODE_ENV` | 运行环境 | `production` |

## 完整示例

```env
# 数据库
DATABASE_URL=postgresql://fwp:password@localhost:5432/fwp

# 安全
JWT_SECRET=my-super-secret-key-change-this
ADMIN_USERNAME=admin
ADMIN_PASSWORD=secure-password-here

# 部署
PORT=3000
NODE_ENV=production

# 通知（可选）
# WEBHOOK_URL=https://hooks.slack.com/xxx
# TELEGRAM_BOT_TOKEN=123456:ABC-DEF
# TELEGRAM_CHAT_ID=-100123456
```
