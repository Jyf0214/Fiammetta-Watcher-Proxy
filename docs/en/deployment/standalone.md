# Node.js Standalone Deployment

This guide covers deploying FWP on your own server or VPS using Node.js directly. Suitable for scenarios requiring full control over the runtime environment.

::: tip Recommended
If self-hosting isn't required, [Cloudflare Deployment](/en/deployment/cloudflare) or [Vercel Deployment](/en/deployment/vercel) offer zero operational cost.
:::

## Requirements

| Dependency | Minimum | Recommended |
|------------|---------|-------------|
| Node.js | 18.0 | 22.x LTS |
| npm | 8.0 | 10.x |
| Database | See below | See below |

Supported databases (selected via `DB_TYPE` environment variable):

| Database | DB_TYPE | Notes |
|----------|---------|-------|
| TiDB Cloud | `tidb` | Free serverless MySQL, recommended |
| PostgreSQL | `pg` | Full features, self-hosted |
| Cloudflare D1 | `d1` | Cloudflare deployments only |

## Step 1: Clone the Project

```bash
git clone https://github.com/Jyf0214/Fiammetta-Watcher-Proxy.git
cd Fiammetta-Watcher-Proxy
git checkout feat/cloudflare-workers
```

## Step 2: Install Dependencies

```bash
npm install
```

The `postinstall` script automatically generates the Prisma Client.

## Step 3: Configure Environment Variables

There is no `.env.example` file. Create `.env` manually:

```bash
cat > .env << 'EOF'
# ===== Database =====
DB_TYPE=tidb
DATABASE_URL=mysql://user:password@host:4000/dbname?sslaccept=accept_invalid_certs

# ===== Security =====
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-admin-password

# ===== JWT (leave empty for auto-generation) =====
JWT_SECRET=

# ===== Service =====
PORT=3000
NODE_ENV=production

# ===== Cron Auth (optional) =====
CRON_SECRET=random-secret-string
EOF
```

::: warning Important
- `DB_TYPE` must be set — determines which Prisma adapter to use
- `DATABASE_URL` must match `DB_TYPE` (`tidb` → MySQL URL, `pg` → PostgreSQL URL)
- `ADMIN_PASSWORD` is required
- `JWT_SECRET` left empty auto-generates a random key
:::

## Step 4: Database Migration

FWP uses multiple schema files, automatically selected based on `DB_TYPE`:

| DB_TYPE | Schema File | Database Command |
|---------|------------|------------------|
| `tidb` | `prisma/schema.mysql.prisma` | MySQL syntax |
| `pg` | `prisma/schema.pg.prisma` | PostgreSQL syntax |
| `d1` | `prisma/schema.d1.prisma` | Cloudflare D1 |

The project provides an automatic preparation script:

```bash
node scripts/prepare-db.mjs
```

This script automatically:

1. Selects the correct Prisma schema based on `DB_TYPE`
2. Generates Prisma Client
3. Pushes database structure (`prisma db push`)

Manual operations:

```bash
# TiDB / MySQL
npx prisma db push --schema=prisma/schema.mysql.prisma

# PostgreSQL
npx prisma db push --schema=prisma/schema.pg.prisma
```

## Step 5: Initialize Admin

FWP automatically creates the admin account from `ADMIN_USERNAME` and `ADMIN_PASSWORD` environment variables on startup. No manual steps needed.

- If no admin exists, one is created from env vars
- If an admin already exists, creation is skipped
- Passwords are hashed with PBKDF2-SHA256 (600,000 iterations)

## Step 6: Start the Service

### Development Mode

```bash
npm run dev
```

Hot reload enabled, defaults to `http://localhost:3000`.

### Production Mode

```bash
npm run build
npm start
```

## Step 7: Access the Admin Panel

```
http://localhost:3000/admin
```

Log in with the credentials configured in Step 3.

## First-Time Setup Wizard

If `DATABASE_URL` is not configured at startup, the system redirects to `/setup` for web-based database and admin configuration. Useful for quick trials.

## Configure Cron Tasks

Non-Cloudflare mode exposes cron tasks as HTTP endpoints:

| Endpoint | Function | Suggested Frequency |
|----------|----------|---------------------|
| `GET /api/cron/model-fetch` | Model discovery | Every 10 minutes |
| `GET /api/cron/key-reset` | Key reset | Daily |
| `GET /api/cron/log-archive` | Log archival | Daily |

If `CRON_SECRET` is set, requests need auth headers:

```bash
curl -H "Authorization: Bearer your-CRON_SECRET" \
  http://localhost:3000/api/cron/model-fetch
```

Use system cron or external services to call these endpoints periodically.

## Troubleshooting

### Database Connection Failed

**Error**: `P1001: Can't reach database server`

1. Verify the database service is running
2. Check host, port, username, and password in `DATABASE_URL`
3. Ensure the database allows remote connections
4. Check firewall rules for the database port

### Port Already in Use

**Error**: `EADDRINUSE: address already in use :::3000`

```bash
lsof -i :3000
PORT=3001 npm start
```

### Prisma Client Not Generated

```bash
npx prisma generate
```

### Memory Optimization

For environments with less than 1GB RAM, add connection pool parameters to `DATABASE_URL`:

```
?connection_limit=5&pool_timeout=10
```

## Related Docs

- [Environment Variables](/en/deployment/env) — Complete env var reference
- [Nginx Configuration](/en/deployment/nginx) — Reverse proxy and HTTPS
- [Cloudflare Deployment](/en/deployment/cloudflare) — Recommended serverless option
