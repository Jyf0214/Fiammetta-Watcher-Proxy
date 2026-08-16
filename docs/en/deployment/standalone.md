# Node.js Standalone Deployment

Run FWP as a full service on your own server / VPS. Suitable when you need full control over the runtime environment or prefer not to use Serverless.

::: tip Branch note
This guide matches the `canary` branch. The `main` / `stable` branches are older versions and do not match this series of docs — use `canary`.
:::

## Requirements

| Dependency | Notes |
|------------|-------|
| Node.js | 22.x |
| Database | TiDB (`tidb`), MariaDB / pure MySQL (`mariadb`) or PostgreSQL (`pg`), remotely accessible |

> `DB_TYPE=d1` is **not supported** for self-hosting (D1 exists only in the Cloudflare runtime).

## Step 1: Clone the Project

```bash
git clone -b canary https://github.com/Jyf0214/Fiammetta-Watcher-Proxy.git
cd Fiammetta-Watcher-Proxy
```

## Step 2: Install Dependencies

```bash
npm install --legacy-peer-deps
```

> No manual database-client preparation needed — the build does it automatically.

## Step 3: Configure Environment Variables

There is no `.env.example` — create `.env` manually:

```bash
cat > .env << 'EOF'
# ===== Database =====
DB_TYPE=pg
DATABASE_URL=postgresql://user:pass@host:port/dbname

# ===== Admin login =====
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-password

# ===== Security =====
JWT_SECRET=random-secret-32+chars

# ===== Service =====
PORT=3000
NODE_ENV=production

# ===== Cron auth (required — without it, /api/cron/* endpoints return 403) =====
CRON_SECRET=random-secret
EOF
```

::: warning Key points
- If `DB_TYPE` is omitted it is inferred from `DATABASE_URL` (`mysql://` → `tidb`, `mariadb://` → `mariadb`, `postgresql://` → `pg`), but setting it explicitly is recommended
- `JWT_SECRET` must be set explicitly and be at least 32 chars — login fails without it
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` are the login credentials themselves
:::

## Step 4: Build and Start

```bash
DB_PUSH=1 npm run build
npx next start
```

- For the first deployment set `DB_PUSH=1`: during the build it runs `prisma db push` against `DATABASE_URL` to create/sync the schema (idempotent, safe to re-run)
- Without `DB_PUSH=1` the build never touches the database (CI environments run db push automatically)
- Port is controlled by `PORT` (default `3000`)
- Start with `npx next start` (`npm start` does not work)

## Step 5: Access the Admin Panel

```
http://localhost:3000/admin
```

Log in with `ADMIN_USERNAME` / `ADMIN_PASSWORD` from `.env`.

## Configure Cron Tasks

Scheduled tasks are exposed as HTTP endpoints — call them via system cron (`crontab -e`); endpoints, frequencies and auth: [Cron Tasks](/en/api/cron).

**crontab example**:

```
0 */6 * * * curl -fsS http://localhost:3000/api/cron/model-fetch -H "Authorization: Bearer your-CRON_SECRET"
0 * * * *   curl -fsS http://localhost:3000/api/cron/key-reset   -H "Authorization: Bearer your-CRON_SECRET"
0 3 * * *   curl -fsS http://localhost:3000/api/cron/log-archive -H "Authorization: Bearer your-CRON_SECRET"
```

## Troubleshooting

Database connection failures, port conflicts, low memory, and other common issues are covered in [Troubleshooting](/en/deployment/troubleshooting).

## Related Docs

- [Environment Variables](/en/deployment/env)
- [Nginx](/en/deployment/nginx) — reverse proxy and HTTPS
- [Docker](/en/deployment/docker) — containerized deployment
