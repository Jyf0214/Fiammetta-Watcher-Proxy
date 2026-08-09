# Node.js 直接部署

在自有服务器 / VPS 上以完整服务方式运行 FWP。适合需要完全控制运行环境、或不便使用 Serverless 的场景。

::: tip 分支说明
本文档对应 `canary` 分支代码。仓库的 `main` / `stable` 分支是旧版本，与本系列文档不符，请使用 `canary` 分支。
:::

## 环境要求

| 依赖 | 说明 |
|------|------|
| Node.js | 22.x |
| 数据库 | TiDB（`tidb`）、MariaDB / 纯 MySQL（`mariadb`）或 PostgreSQL（`pg`），需可远程连接 |

> 自托管**不支持** `DB_TYPE=d1`（D1 仅存在于 Cloudflare 运行时）。

## 第一步：克隆项目

```bash
git clone -b canary https://github.com/Jyf0214/Fiammetta-Watcher-Proxy.git
cd Fiammetta-Watcher-Proxy
```

## 第二步：安装依赖

```bash
npm install --legacy-peer-deps
```

> 不需要手动准备数据库客户端——构建时会自动完成。

## 第三步：配置环境变量

项目没有 `.env.example`，手动创建 `.env`：

```bash
cat > .env << 'EOF'
# ===== 数据库 =====
DB_TYPE=pg
DATABASE_URL=postgresql://用户:密码@主机:端口/数据库名

# ===== 管理后台登录 =====
ADMIN_USERNAME=admin
ADMIN_PASSWORD=你的密码

# ===== 安全 =====
JWT_SECRET=至少32字符的随机密钥

# ===== 服务 =====
PORT=3000
NODE_ENV=production

# ===== Cron 认证（可选） =====
CRON_SECRET=随机密钥
EOF
```

::: warning 关键点
- `DB_TYPE` 不填时会根据 `DATABASE_URL` 自动推断（`mysql://` → `tidb`，`mariadb://` → `mariadb`，`postgresql://` → `pg`），但建议显式设置
- `JWT_SECRET` 必须显式设置且不少于 32 字符（规则见 [环境变量](/deployment/env)），未设置则无法登录
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` 就是登录账号密码本身
:::

## 第四步：构建并启动

```bash
DB_PUSH=1 npm run build
npx next start
```

- 首次部署请设置 `DB_PUSH=1`：构建期间会对 `DATABASE_URL` 指向的数据库自动执行 `prisma db push` 同步表结构（幂等，可重复执行）
- 未设置 `DB_PUSH=1` 时构建不会触碰数据库（CI 环境构建时自动执行，无需设置）
- 监听端口由 `PORT` 控制（默认 `3000`）
- 启动命令用 `npx next start`（`npm start` 不可用）

## 第五步：访问管理后台

```
http://localhost:3000/admin
```

用 `.env` 里的 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登录。

## 配置定时任务

定时任务通过 HTTP 端点暴露，用系统 cron（`crontab -e`）定时调用即可（端点、频率与认证见 [Cron 任务说明](/api/cron)）：

**crontab 示例**：

```
0 */6 * * * curl -fsS http://localhost:3000/api/cron/model-fetch -H "Authorization: Bearer 你的CRON_SECRET"
0 * * * *   curl -fsS http://localhost:3000/api/cron/key-reset   -H "Authorization: Bearer 你的CRON_SECRET"
0 3 * * *   curl -fsS http://localhost:3000/api/cron/log-archive -H "Authorization: Bearer 你的CRON_SECRET"
```

## 常见问题排查

数据库连接失败、端口被占用、内存不足等通用问题的排查步骤见 [常见问题排查](/deployment/troubleshooting)。

## 相关文档

- [环境变量](/deployment/env)
- [Nginx 配置](/deployment/nginx) — 反向代理与 HTTPS
- [Docker 部署](/deployment/docker) — 容器化方式
