# Docker 部署

::: warning 当前状态
官方预构建镜像已发布：`ghcr.io/jyf0214/fiammetta-watcher-proxy:latest`，可直接拉取使用。生产环境更推荐 [Cloudflare 部署](/deployment/cloudflare) 或 [Vercel 部署](/deployment/vercel)。
:::

## 使用预构建镜像

官方镜像已发布到 GHCR，无需本地构建：

```bash
docker pull ghcr.io/jyf0214/fiammetta-watcher-proxy:latest
```

```bash
docker run -d \
  -p 3000:3000 \
  -e DATABASE_URL=postgresql://user:pass@host:5432/dbname \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=your-password \
  -e JWT_SECRET=至少32字符的随机密钥 \
  ghcr.io/jyf0214/fiammetta-watcher-proxy:latest
```

- 数据库类型由连接串自动识别（`postgresql://` 或 `mysql://`）
- 首次启动自动完成建表与管理员初始化，无需额外操作
- `JWT_SECRET` 必填且不少于 32 字符，未设置则无法登录

### 用预构建镜像跑 docker compose

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
      - JWT_SECRET=至少32字符的随机密钥
      - PORT=3000
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

## 相关文档

- [Node.js 直接部署](/deployment/standalone) — 非容器化完整指南
- [环境变量](/deployment/env) — 完整参考
- [Nginx 配置](/deployment/nginx) — 反向代理与 HTTPS
