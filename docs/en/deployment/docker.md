# Docker Deployment

::: warning Current Status
An official pre-built image is published: `ghcr.io/jyf0214/fiammetta-watcher-proxy:latest` — pull and run directly. For production, prefer [Cloudflare](/en/deployment/cloudflare) or [Vercel](/en/deployment/vercel).
:::

## Use the Pre-built Image

The official image is published to GHCR — no local build needed:

```bash
docker pull ghcr.io/jyf0214/fiammetta-watcher-proxy:latest
```

```bash
docker run -d \
  -p 3000:3000 \
  -e DATABASE_URL=postgresql://user:pass@host:5432/dbname \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=your-password \
  -e JWT_SECRET=random-secret-32+chars \
  ghcr.io/jyf0214/fiammetta-watcher-proxy:latest
```

- The database type is detected from the connection string (`postgresql://`, `mysql://` or `mariadb://`)
- On first start it automatically creates the tables and initializes the admin — nothing else to do
- `JWT_SECRET` is required, at least 32 chars — login fails without it

### docker compose with the pre-built image

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

## Related Docs

- [Node.js Standalone](/en/deployment/standalone) — full guide without containers
- [Environment Variables](/en/deployment/env) — full reference
- [Nginx](/en/deployment/nginx) — reverse proxy and HTTPS
