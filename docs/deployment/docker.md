# Docker 部署

::: warning 当前状态
官方预构建镜像已发布：`ghcr.io/jyf0214/fiammetta-watcher-proxy:latest` — 直接拉取运行即可。生产环境建议优先选择 [Cloudflare](/deployment/cloudflare) 或 [Vercel](/deployment/vercel)。
:::

::: tip 分支说明
镜像由仓库 **`stable` 分支**（v1.0.x）构建，包含自动建表、管理员初始化和 `/setup` 引导页等自身功能。本系列其他部署指南基于 `canary` 分支（v2.0.x），功能集有所不同。需要使用最新功能请走 [Node.js 直接部署](/deployment/standalone)。
:::

## 使用预构建镜像

官方镜像发布在 GHCR，无需本地构建：

```bash
docker pull ghcr.io/jyf0214/fiammetta-watcher-proxy:latest
```

```bash
docker run -d \
  -p 3000:3000 \
  -e DATABASE_URL=postgresql://user:pass@host:5432/dbname \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=你的密码 \
  -e JWT_SECRET=至少32字符的随机密钥 \
  ghcr.io/jyf0214/fiammetta-watcher-proxy:latest
```

- 数据库类型根据连接串自动识别（`postgresql://`、`mysql://` 或 `mariadb://`）
- 首次启动自动建表并初始化管理员，无需其他操作
- `JWT_SECRET` 必填且至少 32 字符（见[环境变量](/deployment/env)）— 缺失会导致登录失败

### 用预构建镜像 docker compose

```yaml
services:
  app:
    image: ghcr.io/jyf0214/fiammetta-watcher-proxy:latest
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

> 数据库连接失败、端口冲突等问题见 [常见问题排查](/deployment/troubleshooting)。

## 相关文档

- [Node.js 直接部署](/deployment/standalone) — 非容器化完整指南
- [环境变量](/deployment/env) — 完整参考
- [Nginx 配置](/deployment/nginx) — 反向代理与 HTTPS
