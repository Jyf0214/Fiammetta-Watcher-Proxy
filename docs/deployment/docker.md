# Docker 部署

在自有服务器 / VPS 上用容器运行 FWP，适合需要开箱即用、环境隔离的场景。支持 PostgreSQL（内置或外部）与外部 TiDB / MariaDB 数据库。

::: tip 分支说明
本文档对应 `canary` 分支代码。仓库的 `main` / `stable` 分支是旧版本，与本系列文档不符，请使用 `canary` 分支。
:::

::: warning 与旧版镜像的区别
本页不再提供预构建镜像（旧版 `ghcr.io/jyf0214/fiammetta-watcher-proxy` 由已落后的 `stable` 分支构建）。请按本页方式**本地构建**当前代码的镜像。旧版镜像包含 `/setup` 引导页，canary **没有**该页面，数据库连接串必须在环境变量中直接配置。
:::

## 环境要求

| 依赖 | 说明 |
|------|------|
| Docker | 20.10+（含 Compose v2） |
| 数据库 | 方式一内置 PostgreSQL；方式二需自备 TiDB / MariaDB / PostgreSQL，可远程连接 |

> 容器内**不支持** `DB_TYPE=d1`（D1 仅存在于 Cloudflare 运行时）。

## 方式一：docker compose 一键部署（内置 PostgreSQL）

### 第一步：克隆项目

```bash
git clone -b canary https://github.com/Jyf0214/Fiammetta-Watcher-Proxy.git
cd Fiammetta-Watcher-Proxy
```

### 第二步：创建 .env 配置文件

```bash
cat > .env << 'EOF'
# ===== 数据库（内置 PostgreSQL） =====
POSTGRES_USER=fwp
POSTGRES_PASSWORD=你的数据库密码
POSTGRES_DB=fiammetta_proxy

# ===== 管理后台登录 =====
ADMIN_USERNAME=admin
ADMIN_PASSWORD=你的管理员密码

# ===== 安全 =====
JWT_SECRET=至少32字符的随机密钥

# ===== Cron 认证（可选） =====
CRON_SECRET=随机密钥

# ===== 服务（可选） =====
# PORT=3000
EOF
```

### 第三步：构建并启动

```bash
docker compose up -d --build
```

- 首次启动会构建镜像并自动创建数据库表结构，无需手动执行建表
- 应用监听 `3000` 端口（可用 `PORT` 修改）
- 数据库端口仅绑定 `127.0.0.1`，外部无法直连

### 第四步：访问管理后台

```
http://localhost:3000/admin
```

用 `.env` 里的 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登录。

### 查看日志与停止

```bash
docker compose logs -f app   # 实时日志
docker compose down          # 停止（数据保留在 volume 中）
```

## 方式二：docker compose standalone + 外部数据库

已有 TiDB / MariaDB / PostgreSQL 实例时，只运行应用容器（不内置数据库）。

### 第一步：创建 .env 配置文件

```bash
cat > .env << 'EOF'
# ===== 数据库（外部实例） =====
DATABASE_URL=postgresql://用户:密码@主机:5432/数据库名
# 数据库类型，可选，默认 pg。必须与连接串协议匹配：
#   postgresql:// 配 pg，mysql:// 配 tidb，mariadb:// 配 mariadb
# DB_TYPE=tidb

# ===== 管理后台登录 =====
ADMIN_USERNAME=admin
ADMIN_PASSWORD=你的管理员密码

# ===== 安全 =====
JWT_SECRET=至少32字符的随机密钥

# ===== Cron 认证（可选） =====
CRON_SECRET=随机密钥

# ===== 服务（可选） =====
# PORT=3000
EOF
```

### 第二步：构建并启动

```bash
docker compose -f docker-compose.standalone.yml up -d --build
```

- 首次启动会自动同步外部数据库表结构（幂等），无需手动建表
- `DB_TYPE` 同时决定构建期生成的数据库驱动（compose 构建参数）与运行时类型，**必须与连接串协议匹配**（`postgresql://` 配 `pg`，`mysql://` 配 `tidb`，`mariadb://` 配 `mariadb`）
- 应用监听 `3000` 端口（可用 `PORT` 修改）

### 备选：不用 compose 直接 docker run

```bash
docker build --build-arg DB_TYPE=pg -t fiammetta-watcher-proxy .
```

```bash
docker run -d \
  -p 3000:3000 \
  -e DB_TYPE=pg \
  -e DATABASE_URL=postgresql://用户:密码@主机:端口/数据库名 \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=你的管理员密码 \
  -e JWT_SECRET=至少32字符的随机密钥 \
  -e CRON_SECRET=随机密钥 \
  fiammetta-watcher-proxy
```

- `--build-arg DB_TYPE` 决定构建期生成的数据库驱动，**必须与运行时 `DB_TYPE` 一致**（`pg` / `mariadb` / `tidb`）
- 未设置 `DB_TYPE` 时启动脚本会按 `DATABASE_URL` 协议自动推断

## 环境变量

| 变量 | 说明 | 必填 | 默认值 |
|------|------|------|--------|
| `DB_TYPE` | 数据库类型：`tidb` / `mariadb` / `pg`（容器内不支持 `d1`） | 是 | compose 默认 `pg`；docker run 未设置时按 `DATABASE_URL` 推断 |
| `DATABASE_URL` | 数据库连接串 | 是 | — |
| `ADMIN_USERNAME` | 管理后台登录用户名 | 是 | `admin`（compose） |
| `ADMIN_PASSWORD` | 管理后台登录密码 | 是 | — |
| `JWT_SECRET` | 登录签名密钥，至少 32 字符 | 是 | — |
| `CRON_SECRET` | 定时任务端点访问密钥（未配置时 `/api/cron/*` 返回 403 禁用） | 否 | — |
| `PORT` | 监听端口 | 否 | `3000` |

完整变量参考见 [环境变量](/deployment/env)。

## 配置定时任务

容器内不运行 cron，定时任务通过 HTTP 端点暴露，用宿主机系统 cron（`crontab -e`）定时调用（端点、频率与认证见 [Cron 任务说明](/api/cron)）：

**crontab 示例**：

```
0 */6 * * * curl -fsS http://localhost:3000/api/cron/model-fetch -H "Authorization: Bearer 你的CRON_SECRET"
0 * * * *   curl -fsS http://localhost:3000/api/cron/key-reset   -H "Authorization: Bearer 你的CRON_SECRET"
0 3 * * *   curl -fsS http://localhost:3000/api/cron/log-archive -H "Authorization: Bearer 你的CRON_SECRET"
```

## 常见问题排查

数据库连接失败、端口占用、内存不足等通用问题的排查步骤见 [常见问题排查](/deployment/troubleshooting)。

## 相关文档

- [Node.js 直接部署](/deployment/standalone) — 非容器化完整指南
- [环境变量](/deployment/env) — 完整参考
- [Nginx 配置](/deployment/nginx) — 反向代理与 HTTPS
