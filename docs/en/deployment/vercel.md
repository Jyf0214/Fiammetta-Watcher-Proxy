# Vercel / Non-Cloudflare Platform Deployment

FWP supports deployment to Vercel, Netlify, or any Node.js-compatible Serverless platform. In non-Cloudflare mode, Pages API handles `/v1/*` proxy requests and Cron tasks directly — no Worker needed.

## Differences from Cloudflare Deployment

| Feature | Cloudflare Mode | Non-Cloudflare Mode |
|---------|-----------------|---------------------|
| `/v1/*` proxy | Worker handles | Pages API handles |
| Cron tasks | Worker Cron Triggers | HTTP endpoints + external scheduler |
| Rate limiting | KV persistent | In-memory Map (resets on cold start) |
| Database | D1 (Binding) | TiDB / PostgreSQL (`DATABASE_URL`) |
| Streaming | Worker native | Node.js ReadableStream |

::: tip Key Difference
Non-Cloudflare rate limiting uses in-memory storage that resets on cold start. This is acceptable for most use cases (rate limiting is best-effort).
:::

## Prerequisites

1. [Vercel account](https://vercel.com/signup) (free tier works)
2. [TiDB Cloud](https://tidbcloud.com/) or PostgreSQL database
3. Project GitHub repository

## Method 1: Vercel Deployment

### 1. Import Project

1. Log in to [Vercel Dashboard](https://vercel.com/dashboard)
2. Click "Add New → Project"
3. Import the FWP repository from GitHub
4. Framework preset: **Next.js**
5. Build command: `npm run build`
6. Output directory: `.next`

### 2. Configure Environment Variables

In Vercel project Settings → Environment Variables:

```env
# Database (required)
DB_TYPE=tidb
DATABASE_URL=mysql://user:password@host:4000/dbname?sslaccept=accept_invalid_certs

# Security (required)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-admin-password

# JWT secret (leave empty for auto-generation, or specify)
JWT_SECRET=

# Cron auth secret (optional, for /api/cron/* endpoints)
CRON_SECRET=random-secret-string
```

::: warning Important
- `DB_TYPE` must be `tidb` or `pg` (not `d1` — no D1 Binding available)
- `DATABASE_URL` must be a remote database accessible from Vercel's Serverless functions
- Vercel Serverless functions are stateless; database must support remote connections
:::

### 3. Deploy

Vercel auto-detects `next.config.ts` and triggers build/deploy. Push code to auto-deploy.

### 4. Configure Cron Tasks

Vercel Hobby plan supports Cron. Create `vercel.json` in project root:

```json
{
  "crons": [
    { "path": "/api/cron/model-fetch", "schedule": "*/10 * * * *" },
    { "path": "/api/cron/key-reset", "schedule": "0 0 * * *" },
    { "path": "/api/cron/log-archive", "schedule": "0 1 * * *" }
  ]
}
```

::: tip Vercel Cron Authentication
Vercel Cron automatically adds `Authorization: Bearer <CRON_SECRET>` header. Set `CRON_SECRET` in Vercel environment variables to enable auth. External services can also call these endpoints.
:::

Without Vercel Cron, use external services ([Cron-job.org](https://cron-job.org), [UptimeRobot](https://uptimerobot.com)):

```bash
curl -X GET https://your-domain/api/cron/model-fetch \
  -H "Authorization: Bearer your-CRON_SECRET"
```

## Method 2: Netlify Deployment

### 1. Import Project

1. Log in to [Netlify Dashboard](https://app.netlify.com)
2. Click "Add new site → Import an existing project"
3. Import from GitHub

### 2. Build Configuration

| Setting | Value |
|---------|-------|
| Build command | `npm run build` |
| Publish directory | `.next` |
| Node.js version | 22 |

### 3. Environment Variables

Same as Vercel — configure in Netlify project Settings → Environment variables.

### 4. Cron Tasks

Netlify supports [Scheduled Functions](https://docs.netlify.com/functions/scheduled-functions/) or use external cron services to call `/api/cron/*` endpoints.

## Method 3: Other Node.js Platforms

Non-Cloudflare mode runs on any Node.js platform:

### 1. Build

```bash
npm install
npm run build
```

### 2. Set Environment Variables

```env
DB_TYPE=tidb  # or pg
DATABASE_URL=your-database-connection-string
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-password
```

### 3. Start

```bash
npm start
```

### 4. Configure Cron

Call `/api/cron/*` endpoints via external services:

| Endpoint | Function | Suggested Frequency |
|----------|----------|---------------------|
| `GET /api/cron/model-fetch` | Model discovery | Every 10 minutes |
| `GET /api/cron/key-reset` | Key reset | Daily |
| `GET /api/cron/log-archive` | Log archival | Daily |

Recommended external Cron services:

- [Cron-job.org](https://cron-job.org) — Free, HTTP calls
- [UptimeRobot](https://uptimerobot.com) — Free, monitoring + scheduled calls
- [GitHub Actions](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#schedule) — `schedule` trigger on `main` branch

**GitHub Actions Cron Example**:

```yaml
name: Cron Tasks
on:
  schedule:
    - cron: '*/10 * * * *'
  workflow_dispatch:

jobs:
  model-fetch:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger Model Fetch
        run: |
          curl -X GET "${{ secrets.APP_URL }}/api/cron/model-fetch" \
            -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}"
```

## Database Options

Non-Cloudflare mode supports:

### TiDB Cloud (Recommended Free Option)

1. Sign up at [TiDB Cloud](https://tidbcloud.com/)
2. Create a Serverless cluster (free tier: 500MB storage + 50M RCUs)
3. Connection string:
   ```
   mysql://user:password@gateway01.xxxx.prod.aws.tidbcloud.com:4000/dbname?sslaccept=accept_invalid_certs
   ```

### PostgreSQL

Any remotely accessible PostgreSQL:

- [Neon](https://neon.tech) — Free 512MB
- [Supabase](https://supabase.com) — Free 500MB
- [Railway](https://railway.app) — Free tier
- Self-hosted PostgreSQL

```env
DB_TYPE=pg
DATABASE_URL=postgresql://user:password@host:port/dbname
```

## Troubleshooting

### Rate Limit Resets on Cold Start

Expected behavior. In-memory Map storage resets when the Serverless function cold starts. Rate limiting is best-effort and doesn't affect core functionality.

### Streaming Not Working

Verify the platform supports Node.js `ReadableStream`. Vercel and Netlify both support it, but some platforms may not support Server-Sent Events.

### Database Connection Timeout

In Serverless environments, database connections are ephemeral:

- Ensure the database allows remote connections
- Check firewall/whitelist for Vercel/Netlify IPs
- TiDB Cloud supports remote connections natively

### `/api/cron/*` Returns 401

If `CRON_SECRET` is configured, requests must include `Authorization: Bearer <CRON_SECRET>` header. If `CRON_SECRET` is not set, endpoints require no auth.

## Related Docs

- [Architecture](/en/deployment/architecture) — Dual-mode build architecture
- [Environment Variables](/en/deployment/env) — Complete env var reference
- [Nginx Configuration](/en/deployment/nginx) — Reverse proxy and HTTPS (self-hosted)
