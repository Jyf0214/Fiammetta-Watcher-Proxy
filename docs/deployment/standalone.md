# Node.js 直接部署

本指南介绍如何在自有服务器或 VPS 上通过 Node.js 直接运行 FWP。适合需要完全控制运行环境的场景。

::: tip 推荐方案
如果不需要自托管，推荐使用 [Cloudflare 部署](/deployment/cloudflare) 或 [Vercel 部署](/deployment/vercel)，零运维成本。
:::

## 环境要求

| 依赖 | 最低版本 | 推荐版本 |
|------|----------|----------|
| Node.js | 18.0 | 22.x LTS |
| npm | 8.0 | 10.x |
| 数据库 | 见下方 | 见下方 |

支持的数据库（通过 `DB_TYPE` 环境变量选择）：

| 数据库 | DB_TYPE | 说明 |
|--------|---------|------|
| TiDB Cloud | `tidb` | 免费 Serverless MySQL，推荐 |
| PostgreSQL | `pg` | 功能最全，适合自建 |
| Cloudflare D1 | `d1` | 仅限 Cloudflare 部署 |

## 第一步：克隆项目

```bash
git clone https://github.com/Jyf0214/Fiammetta-Watcher-Proxy.git
cd Fiammetta-Watcher-Proxy
git checkout feat/cloudflare-workers
```

## 第二步：安装依赖

```bash
npm install
```

`npm install` 会自动执行 `postinstall` 脚本，生成 Prisma Client。

## 第三步：配置环境变量

项目没有 `.env.example` 文件。请手动创建 `.env` 文件：

```bash
cat > .env << 'EOF'
# ===== 数据库配置 =====
DB_TYPE=tidb
DATABASE_URL=mysql://用户名:密码@host:4000/dbname?sslaccept=accept_invalid_certs

# ===== 安全配置 =====
ADMIN_USERNAME=admin
ADMIN_PASSWORD=你的管理员密码

# ===== JWT 密钥（留空自动生成） =====
JWT_SECRET=

# ===== 服务配置 =====
PORT=3000
NODE_ENV=production

# ===== Cron 认证（可选） =====
CRON_SECRET=随机生成的密钥字符串
EOF
```

::: warning 重要
- `DB_TYPE` 必须设置，决定使用哪种 Prisma 适配器
- `DATABASE_URL` 必须与 `DB_TYPE` 匹配（`tidb` 用 MySQL URL，`pg` 用 PostgreSQL URL）
- `ADMIN_PASSWORD` 必须设置
- `JWT_SECRET` 留空会自动生成随机密钥
:::

## 第四步：数据库迁移

FWP 使用多 Schema 文件，根据 `DB_TYPE` 自动选择对应的 schema：

| DB_TYPE | Schema 文件 | 数据库命令 |
|---------|------------|-----------|
| `tidb` | `prisma/schema.mysql.prisma` | MySQL 语法 |
| `pg` | `prisma/schema.pg.prisma` | PostgreSQL 语法 |
| `d1` | `prisma/schema.d1.prisma` | Cloudflare D1 |

项目提供了自动准备脚本：

```bash
node scripts/prepare-db.mjs
```

该脚本会根据 `DB_TYPE` 自动：
1. 选择对应的 Prisma schema
2. 生成 Prisma Client
3. 推送数据库结构（`prisma db push`）

如果你需要手动操作：

```bash
# TiDB / MySQL
npx prisma db push --schema=prisma/schema.mysql.prisma

# PostgreSQL
npx prisma db push --schema=prisma/schema.pg.prisma
```

## 第五步：初始化管理员

启动应用时，FWP 会自动根据 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 环境变量创建管理员账户。无需手动执行额外命令。

管理员初始化逻辑：

1. 如果数据库中没有管理员账户，则从环境变量自动创建
2. 如果管理员已存在，则跳过创建
3. 密码使用 PBKDF2-SHA256（600000 次迭代）哈希存储

## 第六步：启动服务

### 开发模式

```bash
npm run dev
```

开发模式下支持热更新，默认监听 `http://localhost:3000`。

### 生产模式

```bash
npm run build
npm start
```

## 第七步：访问管理后台

打开浏览器访问：

```
http://localhost:3000/admin
```

使用第三步配置的 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 登录。

## 首次配置向导

如果启动时未配置 `DATABASE_URL`，系统会自动引导到 `/setup` 页面，在网页上完成数据库和管理员的配置。这种模式适合快速试用，无需提前准备数据库。

## 配置定时任务

非 Cloudflare 模式下，定时任务通过 HTTP 端点暴露：

| 端点 | 功能 | 建议频率 |
|------|------|----------|
| `GET /api/cron/model-fetch` | 模型发现 | 每 10 分钟 |
| `GET /api/cron/key-reset` | Key 重置 | 每天 |
| `GET /api/cron/log-archive` | 日志归档 | 每天 |

如果设置了 `CRON_SECRET`，请求需要携带认证头：

```bash
curl -H "Authorization: Bearer 你的CRON_SECRET" \
  http://localhost:3000/api/cron/model-fetch
```

使用系统 cron 或外部服务定时调用这些端点。

## 常见问题排查

### 数据库连接失败

**错误信息**: `P1001: Can't reach database server`

排查步骤：

1. 确认数据库服务已启动
2. 检查 `DATABASE_URL` 中的主机、端口、用户名、密码是否正确
3. 检查数据库是否允许远程连接（MySQL 需检查 `bind-address`）
4. 检查防火墙是否放行了数据库端口

### 端口被占用

**错误信息**: `EADDRINUSE: address already in use :::3000`

```bash
lsof -i :3000
PORT=3001 npm start
```

### Prisma Client 未生成

```bash
npx prisma generate
```

### 数据库内存优化

在内存小于 1GB 的环境中，建议在 `DATABASE_URL` 末尾添加连接池参数：

```
?connection_limit=5&pool_timeout=10
```

## 相关文档

- [环境变量](/deployment/env) — 完整环境变量参考
- [Nginx 配置](/deployment/nginx) — 反向代理和 HTTPS
- [Cloudflare 部署](/deployment/cloudflare) — 推荐的 Serverless 方案
