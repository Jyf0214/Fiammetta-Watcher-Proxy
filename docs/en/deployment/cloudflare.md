# Cloudflare Deployment

FWP's native deployment platform. Cloudflare Pages hosts the frontend and admin API, Cloudflare Worker handles `/v1/*` proxy and scheduled tasks, D1 serves as the database. Global edge nodes, zero operational cost.

## Architecture Overview

```
┌─────────────────────────────────────────────┐
│              Cloudflare Edge                │
│                                             │
│  ┌──────────────┐  ┌──────────────────────┐ │
│  │   Worker     │  │      Pages           │ │
│  │              │  │                      │ │
│  │ /v1/* proxy  │  │ Frontend (React/     │ │
│  │ Cron tasks   │  │   Next.js)           │ │
│  │              │  │ /api/admin/* admin   │ │
│  │              │  │ /api/setup/* init    │ │
│  └──────┬───────┘  └──────────┬───────────┘ │
│         │                     │             │
│         └─────────┬───────────┘             │
│                   ▼                         │
│          ┌──────────────┐                   │
│          │   D1 Database│                   │
│          │  (SQLite)    │                   │
│          └──────────────┘                   │
└─────────────────────────────────────────────┘
```

- **Worker**: Handles `/v1/*` proxy requests (API key validation → routing → forwarding → streaming) and Cron tasks (model discovery, key reset, log archival)
- **Pages**: Hosts frontend static assets and admin API (platform management, key management, usage monitoring, etc.)
- **D1**: Cloudflare's native SQLite database, connected via Binding — no `DATABASE_URL` needed

## Prerequisites

1. [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
2. [GitHub account](https://github.com)
3. Fork the project repository to your account

## Method 1: GitHub Actions Auto-Deploy (Recommended)

### 1. Create Cloudflare Resources

The project provides an automation script to create all required Cloudflare resources:

```bash
# Clone the project
git clone https://github.com/your-username/Fiammetta-Watcher-Proxy.git
cd Fiammetta-Watcher-Proxy

# Get Cloudflare API Token
# Visit https://dash.cloudflare.com/profile/api-tokens
# Create a token with: Account > Cloudflare Workers > Edit, D1 > Edit, Pages > Edit

# Install Python (required by the script)
pip install -r deploy/requirements.txt

# Run initialization script (creates D1, KV, Worker, Pages project)
export CLOUDFLARE_API_TOKEN="your-api-token"
export CLOUDFLARE_ACCOUNT_ID="your-account-id"
python deploy/init.py
```

`init.py` runs three phases:

1. **pre-check**: Verify account permissions and existing resources
2. **create**: Create D1 database, KV namespace, Worker, Pages project; configure bindings
3. **post-check**: Verify resource creation succeeded

### 2. Configure GitHub Secrets

Add these in your GitHub repo's Settings → Secrets and variables → Actions:

| Secret Name | Description | Source |
|-------------|-------------|--------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token | [Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID | [Cloudflare Dashboard](https://dash.cloudflare.com/) right sidebar |
| `CF_D1_DATABASE_ID` | D1 Database ID | Output from init.py |
| `CF_KV_NAMESPACE_ID` | KV Namespace ID | Output from init.py |

::: tip
After `init.py` completes, it prints all required IDs in the terminal. Copy them directly to GitHub Secrets.
:::

### 3. Configure Environment Variables

In Cloudflare Dashboard → Workers & Pages → Your Worker → Settings → Variables:

| Variable | Value | Type |
|----------|-------|------|
| `ADMIN_USERNAME` | Admin username | Text |
| `ADMIN_PASSWORD` | Admin password | Text (Encrypted) |
| `CRON_SECRET` | Cron auth secret (optional) | Text (Encrypted) |

::: warning
Worker environment variables are configured in the Cloudflare Dashboard, not GitHub Secrets. D1 bindings are auto-configured by `init.py`.
:::

### 4. Trigger Deployment

Push to the `main` branch to auto-deploy:

```bash
git push origin main
```

Deployment pipeline:

1. `build:cf` — Cloudflare mode build (temporarily remove v1/cron routes → OpenNext build → restore routes)
2. Worker deploys to Cloudflare Workers
3. Pages deploys to Cloudflare Pages
4. D1 database schema auto-migrates

### 5. Verify Deployment

```bash
# Check Worker health
curl https://your-worker-subdomain.workers.dev/v1/models

# Check Pages admin panel
curl https://your-pages-subdomain.pages.dev/api/health
```

## Method 2: Manual Wrangler Deploy

For development, debugging, or custom deployment workflows.

### 1. Install Wrangler

```bash
npm install -g wrangler
wrangler login
```

### 2. Create Resources

```bash
# Create D1 database
wrangler d1 create fiammetta-watcher-db
# Note the database_id, update wrangler.toml

# Create KV namespace
wrangler kv namespace create CACHE
wrangler kv namespace create CACHE --preview
# Note the id, update wrangler.toml
```

### 3. Configure wrangler.toml

Edit `worker/wrangler.toml`:

```toml
name = "fwp-worker"
main = "worker/src/index.ts"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "DB"
database_name = "fiammetta-watcher-db"
database_id = "your-database-id"

[[kv_namespaces]]
binding = "CACHE"
id = "your-kv-namespace-id"

[vars]
DB_TYPE = "d1"
```

### 4. Initialize Database

```bash
npx wrangler d1 execute fiammetta-watcher-db --file=./migrations/0001_init_schema.sql
```

### 5. Deploy Worker

```bash
cd worker
wrangler deploy
```

### 6. Deploy Pages

```bash
CF_DEPLOY=true npm run build:cf
npx wrangler pages deploy .open-next/assets --project-name=your-pages-project
```

## Cron Task Configuration

FWP has 3 scheduled tasks:

| Task | Path | Default Frequency | Function |
|------|------|-------------------|----------|
| Model Discovery | `model-fetch` | Every 10 min | Auto-discover platform models |
| Key Reset | `key-reset` | Daily | Reset key usage counters |
| Log Archival | `log-archive` | Daily | Archive old request logs to stats |

Configure Cron Triggers in `worker/wrangler.toml`:

```toml
[triggers]
crons = ["*/10 * * * *", "0 0 * * *", "0 1 * * *"]
```

Or in Cloudflare Dashboard → Worker → Settings → Triggers → Cron Triggers.

## Troubleshooting

### Build Failure: OpenNext Errors

Verify `package.json` `build:cf` script is complete:

```json
{
  "scripts": {
    "build:cf": "CF_DEPLOY=true bash scripts/build-gate.sh && node scripts/prepare-db.mjs && opennextjs-cloudflare build && CF_DEPLOY=true bash scripts/build-gate-restore.sh"
  }
}
```

### Worker CPU Timeout

::: warning Free Tier Limitation
Cloudflare Workers Free plan CPU limit is 10ms/request. Proxying AI API requests frequently exceeds this limit, causing repeated failures. You must either upgrade to Workers Paid plan (50ms CPU/request), or switch to another deployment method (e.g., [Vercel](/en/deployment/vercel), [Node.js Standalone](/en/deployment/standalone)).
:::

Troubleshooting:

- Check for unnecessary synchronous computation
- Ensure `prisma.$disconnect()` is not called (destroys connection cache, causing CPU spikes)

### D1 Connection Issues

Verify:

- `database_id` in `wrangler.toml` is correct
- Worker env var `DB_TYPE = "d1"` is set
- No `DATABASE_URL` is used (D1 connects via Binding, not URL)

### Streaming Response Interruption

If SSE streaming frequently drops:

- Check that `ctx.waitUntil()` properly protects async writes in the Worker
- Request timeout settings (default 120 seconds)

## Related Docs

- [Architecture](/en/deployment/architecture) — Dual-mode build architecture
- [Environment Variables](/en/deployment/env) — Complete env var reference
- [Wrangler Configuration](https://developers.cloudflare.com/workers/wrangler/)
