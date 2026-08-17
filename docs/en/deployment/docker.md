# Docker Deployment

::: warning Current Status
An official pre-built image is published: `ghcr.io/jyf0214/fiammetta-watcher-proxy:canary` — pull and run directly. For production, prefer [Cloudflare](/en/deployment/cloudflare) or [Vercel](/en/deployment/vercel).
:::

::: tip Version Note
The image is built from the **`canary` branch** of the repository and matches this series of docs. The canary branch has no `/setup` onboarding page (a `stable` branch v1.0.x feature): Docker deployments must set `DATABASE_URL`, tables are synced automatically on startup, and the admin account is configured via environment variables.
:::

## Image Versions

| Image | Contents |
|-------|----------|
| `ghcr.io/jyf0214/fiammetta-watcher-proxy:canary` | Full: admin panel + V1 proxy + scheduled tasks |
| `ghcr.io/jyf0214/fiammetta-watcher-proxy:canary-lite` | Lite: V1 proxy and scheduled task APIs only, no admin panel |

Images are built by GitHub Actions: trigger the **Docker Build** workflow manually from the Actions tab (choose `DB_TYPE`), or push a `canary` tag.

## Use the Pre-built Image (Full)

```bash
docker pull ghcr.io/jyf0214/fiammetta-watcher-proxy:canary
```

```bash
docker run -d \
  -p 3000:3000 \
  -e DATABASE_URL=postgresql://user:pass@host:5432/dbname \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=your-password \
  -e JWT_SECRET=random-secret-32+chars \
  ghcr.io/jyf0214/fiammetta-watcher-proxy:canary
```

- The database type is detected from the connection string (`postgresql://`, `mariadb://` or `mysql://`), or set explicitly via `DB_TYPE`; `tidb` / `mariadb` / `pg` are supported (D1 exists only in the Cloudflare runtime)
- Tables are synced automatically on startup (idempotent) — no manual setup
- The admin account is configured via `ADMIN_USERNAME` / `ADMIN_PASSWORD` environment variables
- `JWT_SECRET` is required, at least 32 chars (see [Environment Variables](/en/deployment/env)) — login fails without it

### docker compose with the pre-built image

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

## Scheduled Tasks

The container registers an in-container timer at startup — all scheduled tasks run automatically with zero configuration:

| Task | Frequency |
|------|-----------|
| Model discovery (model-fetch) | Every 6 hours |
| Key usage reset (key-reset) | Hourly |
| Log archival (log-archive) | Daily at 3:10 |
| Outbound proxy health check (proxy-health) | Every 5 minutes (customizable to 1–60 minutes under Global settings on the outbound proxy page) |
| Outbound proxy list pull (proxy-pull) | Hourly |

No external scheduler is needed for `/api/cron/*`, and `CRON_SECRET` is **not required** (the timer calls the task functions directly, bypassing the HTTP endpoints). `CRON_SECRET` is only needed when calling the endpoints externally.

> Scheduled tasks run in the container's local timezone (UTC by default; adjust with the `TZ` environment variable). Log archival is set to 3:10 to offset from the hourly key usage reset at the top of the hour, avoiding concurrent database writes.

## Lite Image (:canary-lite)

The lite image provides only the V1 proxy and scheduled task APIs — no admin panel. It suits gateways that already have an admin frontend elsewhere. Environment-variable requirements are the same as the full image.

```bash
docker pull ghcr.io/jyf0214/fiammetta-watcher-proxy:canary-lite
```

## Built-in Compose Files

The repository ships two compose files — clone it and use them directly:

- `docker-compose.yml` — app + PostgreSQL in one deployment (bundled database, with security hardening and health checks), ready to use out of the box
- `docker-compose.standalone.yml` — app + external database (bring your own PostgreSQL / TiDB / MariaDB)

Create a `.env` file in the repo root and fill in the required values (see the comments in the compose file — `POSTGRES_PASSWORD` / `DATABASE_URL` / `ADMIN_PASSWORD` / `JWT_SECRET`, etc.; compose refuses to start if they are missing), then:

```bash
docker compose up -d
```

> For database connection failures, port conflicts, etc., see [Troubleshooting](/en/deployment/troubleshooting).

## Related Docs

- [Node.js Standalone](/en/deployment/standalone) — full guide without containers
- [Environment Variables](/en/deployment/env) — full reference
- [Nginx](/en/deployment/nginx) — reverse proxy and HTTPS
