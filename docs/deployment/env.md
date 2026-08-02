# 环境变量

Serverless 平台（Cloudflare / Vercel / EdgeOne）在平台控制台或 GitHub Secrets 中配置环境变量；自托管写入 `.env` 文件。项目没有 `.env.example`，以下清单以 `.env` 格式给出。

## 核心配置（所有平台）

| 变量 | 说明 | 必填 | 默认值 |
|------|------|------|--------|
| `DB_TYPE` | 数据库类型：`d1` / `tidb` / `mariadb` / `pg` | 是 | `d1`（**仅 Cloudflare 适用**；Vercel/EdgeOne/Docker/Node 必须显式设置为 `tidb`/`mariadb`/`pg`） |
| `DATABASE_URL` | 数据库连接串（`d1` 不需要） | `tidb`/`mariadb`/`pg` 必须 | — |
| `ADMIN_USERNAME` | 管理后台登录用户名 | 是 | 无 |
| `ADMIN_PASSWORD` | 管理后台登录密码 | 是 | 无 |
| `JWT_SECRET` | 登录签名密钥，至少 32 字符 | 是 | 无（Cloudflare CI 自动生成，其他平台需手动设置） |

::: warning
`DB_TYPE` 必须与实际数据库一致：`tidb` 配 MySQL 协议连接串，`mariadb` 配 `mariadb://` 连接串，`pg` 配 PostgreSQL 协议连接串
:::

## 服务（自托管）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 监听端口 | `3000` |
| `NODE_ENV` | 运行环境 | `production` |

## Cron 认证（可选）

| 变量 | 说明 |
|------|------|
| `CRON_SECRET` | 定时任务端点访问密钥；设置后调用需带 `Authorization: Bearer <CRON_SECRET>` 头 |

## 按平台配置

各平台的配置入口与完整示例见对应部署指南：

- [Cloudflare 部署](/deployment/cloudflare) — 在 GitHub Secrets 配置；`ADMIN_USERNAME`、`ADMIN_PASSWORD`、`JWT_SECRET` 由部署脚本自动写入 Cloudflare
- [Vercel 部署](/deployment/vercel) — Settings → Environment Variables
- [EdgeOne 部署](/deployment/edgeone) — Makers 控制台运行时环境变量
- [Node.js 直接部署](/deployment/standalone) — `.env` 文件

## 数据库连接串格式

**TiDB Cloud / MySQL**：

```
mysql://用户名:密码@gateway01.xxxx.prod.aws.tidbcloud.com:4000/dbname?sslaccept=accept_invalid_certs
```

**MariaDB / 纯 MySQL（mariadb 驱动）**：

```
mariadb://用户名:密码@主机:端口/数据库名
```

**PostgreSQL**：

```
postgresql://用户:密码@主机:端口/数据库名
```

内存小于 1GB 的环境，可在连接串末尾追加连接池参数：`?connection_limit=5&pool_timeout=10`

## 相关文档

- [部署指南](/deployment/) — 平台对比与选择
- [Cloudflare 部署](/deployment/cloudflare)
- [Vercel 部署](/deployment/vercel)
- [EdgeOne 部署](/deployment/edgeone)
