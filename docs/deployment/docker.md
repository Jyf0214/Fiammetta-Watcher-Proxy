# Docker 部署

::: warning 当前状态
项目目前**没有提供官方 Dockerfile**。以下内容为自建 Docker 部署的参考方案。推荐使用 [Cloudflare 部署](/deployment/cloudflare) 或 [Node.js 直接部署](/deployment/standalone)。
:::

## 自建 Docker 部署

如果你需要容器化部署，可以参考以下方案自行创建 Dockerfile。

### 1. Dockerfile 参考

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# 根据 DB_TYPE 选择 schema 并准备数据库
ARG DB_TYPE=pg
ENV DB_TYPE=${DB_TYPE}
RUN node scripts/prepare-db.mjs
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
```

::: warning 注意
项目 `next.config.ts` 中**没有设置 `output: 'standalone'`**。如果需要使用上述 Dockerfile，需要先在 `next.config.ts` 中添加 `output: 'standalone'`，或者改用 `npm start` 方式启动。
:::

### 2. docker-compose.yml 参考

```yaml
services:
  app:
    build:
      context: .
      args:
        DB_TYPE: pg
    ports:
      - "3000:3000"
    environment:
      - DB_TYPE=pg
      - DATABASE_URL=postgresql://fwp:password@db:5432/fwp
      - ADMIN_USERNAME=admin
      - ADMIN_PASSWORD=secure-password
      - JWT_SECRET=
      - PORT=3000
      - NODE_ENV=production
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped

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

### 3. 使用步骤

```bash
# 克隆项目
git clone https://github.com/Jyf0214/Fiammetta-Watcher-Proxy.git
cd Fiammetta-Watcher-Proxy
git checkout feat/cloudflare-workers

# 构建并启动
docker compose up -d

# 查看日志
docker compose logs -f

# 停止服务
docker compose down
```

### 4. 使用 MySQL / TiDB

如果使用 TiDB Cloud 或 MySQL，修改 docker-compose.yml 中的数据库配置：

```yaml
services:
  app:
    environment:
      - DB_TYPE=tidb
      - DATABASE_URL=mysql://user:password@gateway01.xxxx.prod.aws.tidbcloud.com:4000/dbname?sslaccept=accept_invalid_certs
      - ADMIN_USERNAME=admin
      - ADMIN_PASSWORD=secure-password
    # 移除 db 依赖和 db 服务
```

## 纯容器运行（无 Docker Compose）

```bash
# 使用 PostgreSQL
docker build -t fwp --build-arg DB_TYPE=pg .
docker run -d \
  -p 3000:3000 \
  -e DB_TYPE=pg \
  -e DATABASE_URL=postgresql://user:pass@host:5432/fwp \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=your-password \
  fwp

# 使用 TiDB Cloud
docker build -t fwp --build-arg DB_TYPE=tidb .
docker run -d \
  -p 3000:3000 \
  -e DB_TYPE=tidb \
  -e DATABASE_URL=mysql://user:pass@host:4000/dbname?sslaccept=accept_invalid_certs \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=your-password \
  fwp
```

## 相关文档

- [Node.js 直接部署](/deployment/standalone) — 不使用容器的完整部署指南
- [环境变量](/deployment/env) — 完整环境变量参考
- [Nginx 配置](/deployment/nginx) — 反向代理和 HTTPS
