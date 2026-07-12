# Docker 部署

## 使用 Docker Compose

### 1. 克隆项目

```bash
git clone https://github.com/Jyf0214/Fiammetta-Watcher-Proxy.git
cd Fiammetta-Watcher-Proxy
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env` 文件，填写必要配置（参见[环境变量](/deployment/env)）。

### 3. 启动服务

```bash
docker compose up -d
```

### 4. 查看日志

```bash
docker compose logs -f
```

### 5. 停止服务

```bash
docker compose down
```

## Docker Compose 配置说明

默认的 `docker-compose.yml` 包含：

- **app** — FWP 应用服务
- **db** — PostgreSQL 数据库

```yaml
services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgresql://fwp:password@db:5432/fwp
      - JWT_SECRET=your-secret-key
    depends_on:
      - db

  db:
    image: postgres:16-alpine
    environment:
      - POSTGRES_DB=fwp
      - POSTGRES_USER=fwp
      - POSTGRES_PASSWORD=password
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

## 单独使用 Docker

```bash
docker build -t fwp .
docker run -d \
  -p 3000:3000 \
  -e DATABASE_URL=postgresql://user:pass@host:5432/fwp \
  -e JWT_SECRET=your-secret \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=your-password \
  fwp
```

## 下一步

- [环境变量](/deployment/env) — 所有配置项说明
- [Nginx 配置](/deployment/nginx) — 反向代理配置
