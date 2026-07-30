# Docker Deployment

::: warning Current Status
The project does **not include an official Dockerfile**. The following is a reference for self-built Docker deployment. Consider [Cloudflare Deployment](/en/deployment/cloudflare) or [Node.js Standalone](/en/deployment/standalone) instead.
:::

## Self-Built Docker Deployment

If you need containerized deployment, create your own Dockerfile using the reference below.

### 1. Dockerfile Reference

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
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

::: warning Note
The project's `next.config.ts` does **not** set `output: 'standalone'`. To use the Dockerfile above, either add `output: 'standalone'` to `next.config.ts`, or start with `npm start` instead.
:::

### 2. docker-compose.yml Reference

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

### 3. Usage

```bash
git clone https://github.com/Jyf0214/Fiammetta-Watcher-Proxy.git
cd Fiammetta-Watcher-Proxy
git checkout feat/cloudflare-workers

docker compose up -d
docker compose logs -f
docker compose down
```

### 4. Using MySQL / TiDB

For TiDB Cloud or MySQL, modify the database config:

```yaml
services:
  app:
    environment:
      - DB_TYPE=tidb
      - DATABASE_URL=mysql://user:password@gateway01.xxxx.prod.aws.tidbcloud.com:4000/dbname?sslaccept=accept_invalid_certs
      - ADMIN_USERNAME=admin
      - ADMIN_PASSWORD=secure-password
    # Remove db dependency and db service
```

## Standalone Container (No Docker Compose)

```bash
# PostgreSQL
docker build -t fwp --build-arg DB_TYPE=pg .
docker run -d \
  -p 3000:3000 \
  -e DB_TYPE=pg \
  -e DATABASE_URL=postgresql://user:pass@host:5432/fwp \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=your-password \
  fwp

# TiDB Cloud
docker build -t fwp --build-arg DB_TYPE=tidb .
docker run -d \
  -p 3000:3000 \
  -e DB_TYPE=tidb \
  -e DATABASE_URL=mysql://user:pass@host:4000/dbname?sslaccept=accept_invalid_certs \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=your-password \
  fwp
```

## Related Docs

- [Node.js Standalone](/en/deployment/standalone) — Complete deployment guide without containers
- [Environment Variables](/en/deployment/env) — Complete env var reference
- [Nginx Configuration](/en/deployment/nginx) — Reverse proxy and HTTPS
