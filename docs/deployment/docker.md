# Docker 部署

::: warning 当前状态
官方预构建镜像已发布：`ghcr.io/jyf0214/fiammetta-watcher-proxy:canary` — 直接拉取运行即可。生产环境建议优先选择 [Cloudflare](/deployment/cloudflare) 或 [Vercel](/deployment/vercel)。
:::

::: tip 分支说明
镜像由仓库 **`canary` 分支**构建，与本系列文档一致。canary 没有 `/setup` 引导页（旧 `stable` 分支 v1.0.x 的功能）：Docker 部署必须配置 `DATABASE_URL`，启动时自动同步表结构，管理员账号通过环境变量配置。
:::

## 镜像版本

| 镜像 | 内容 |
|------|------|
| `ghcr.io/jyf0214/fiammetta-watcher-proxy:canary` | 完整版：管理后台 + V1 代理 + 定时任务 |
| `ghcr.io/jyf0214/fiammetta-watcher-proxy:canary-lite` | 精简版：仅 V1 代理与定时任务 API，无管理后台 |

镜像由 GitHub Actions 构建：网页手动触发 **Docker Build** 工作流（选择 `DB_TYPE`），或推送 `canary` 标签时自动构建。

## 使用预构建镜像（完整版）

```bash
docker pull ghcr.io/jyf0214/fiammetta-watcher-proxy:canary
```

```bash
docker run -d \
  -p 3000:3000 \
  -e DATABASE_URL=postgresql://user:pass@host:5432/dbname \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=你的密码 \
  -e JWT_SECRET=至少32字符的随机密钥 \
  ghcr.io/jyf0214/fiammetta-watcher-proxy:canary
```

- 数据库类型按连接串自动识别（`postgresql://` → PostgreSQL、`mariadb://` → MariaDB、`mysql://` → TiDB），也可用 `DB_TYPE` 显式指定；支持 `tidb` / `mariadb` / `pg`（D1 仅存在于 Cloudflare 运行时，不支持）
- 启动时自动同步表结构（幂等），无需手动建表
- 管理员账号由 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 环境变量配置
- `JWT_SECRET` 必填且至少 32 字符（见[环境变量](/deployment/env)）— 缺失会导致登录失败

### 用预构建镜像 docker compose

```yaml
services:
  app:
    image: ghcr.io/jyf0214/fiammetta-watcher-proxy:canary
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgresql://fwp:password@db:5432/fwp
      - ADMIN_USERNAME=admin
      - ADMIN_PASSWORD=secure-password
      - JWT_SECRET=random-secret-32+chars
    depends_on:
      db:
        condition: service_healthy

  db:
    image: postgres:16-alpine
    environment:
      - POSTGRES_DB=fwp
      - POSTGRES_USER=fwp
      - POSTGRES_PASSWORD=password
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U fwp"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  pgdata:
```

## 精简版镜像（:canary-lite）

精简版只提供 V1 代理与定时任务 API，不含管理后台前端。适合已有管理后台、仅需网关转发的场景。环境变量要求与完整版相同。

```bash
docker pull ghcr.io/jyf0214/fiammetta-watcher-proxy:canary-lite
```

## 仓库内置 compose 文件

仓库自带两个 compose 文件，克隆后即可使用：

- `docker-compose.yml` — 应用 + PostgreSQL 一体式部署（内置数据库，含安全加固与健康检查），适合开箱即用
- `docker-compose.standalone.yml` — 应用 + 外部数据库（自备 PostgreSQL / TiDB / MariaDB）

在仓库根目录创建 `.env` 文件，按 compose 内注释填写必填项（`POSTGRES_PASSWORD` / `DATABASE_URL` / `ADMIN_PASSWORD` / `JWT_SECRET` 等，缺失时 compose 会报错提示），然后：

```bash
docker compose up -d
```

> 数据库连接失败、端口冲突等问题见 [常见问题排查](/deployment/troubleshooting)。

## 相关文档

- [Node.js 直接部署](/deployment/standalone) — 非容器化完整指南
- [环境变量](/deployment/env) — 完整参考
- [Nginx 配置](/deployment/nginx) — 反向代理与 HTTPS
