# Cloudflare Deployment

FWP on Cloudflare consists of two parts: the **Worker** handles the `/v1/*` proxy and 3 scheduled tasks, while **Pages** serves the frontend and admin panel. Both share the same database.

- Database defaults to `DB_TYPE=d1` (Cloudflare D1 — free, zero configuration); TiDB/PG are also supported
- GitHub Actions auto-deploy is recommended: push the code and everything is published

## Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works; for production, consider Workers Paid — see [Troubleshooting](#troubleshooting))
- A GitHub account

## Option 1: GitHub Actions Auto-Deploy (Recommended)

All done from the web UI — no local terminal needed.

### 1. Fork the Project

Open [Fiammetta-Watcher-Proxy](https://github.com/Jyf0214/Fiammetta-Watcher-Proxy) and click Fork (top right) to copy it to your GitHub account.

### 2. Enable the Workflow

Open the Actions tab of your fork and enable the workflow if prompted (the first run may need approval).

### 3. Configure GitHub Secrets

Repo Settings → Secrets and variables → Actions → New repository secret:

| Secret | Description |
|--------|-------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token (account-level Edit; [create here](https://dash.cloudflare.com/profile/api-tokens)) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID (Dashboard sidebar) |

> Generic variables (`DB_TYPE`, `DATABASE_URL`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `JWT_SECRET`) — see [Environment Variables](/en/deployment/env). Of these, `ADMIN_USERNAME`, `ADMIN_PASSWORD` and `JWT_SECRET` are written into Cloudflare automatically by the deploy script; `ADMIN_PASSWORD` is required — deployment fails without it.

### 4. Trigger the Deployment

Actions tab → Deploy workflow → Run workflow → **branch `canary`** (the fork's default branch is not `canary` — select it explicitly) → platform `cf` → Run workflow.

It automatically: creates the database and cache resources → builds → deploys the Worker → deploys Pages → configures the admin credentials. No Cloudflare console interaction needed.

### 5. Verify

| Check | URL |
|-------|-----|
| Health | `curl -H "Authorization: Bearer <system-api-key>" https://<project>.pages.dev/api/health` → `{"status":"ok",...}` (admin auth required) |
| Proxy | `https://<worker>.<account>.workers.dev/v1/models` (no API Key needed — a 200 model list is expected; only POST proxy endpoints require auth) |
| Admin panel | `https://<project>.pages.dev/admin`, log in with the credentials from Secrets |

> Worker/Pages domains are listed in Dashboard → Workers & Pages. For production, bind a custom domain (Dashboard → project → Custom domains).

> The `<system-api-key>` above refers to a **System API Key** (`sk-sys-*`): after deployment, log in to the admin panel at `https://<project>.pages.dev/admin` → "System Keys" page on the left and generate one. It is used for Bearer auth on system-level endpoints and is independent of user API Keys.

## Option 2: Manual Deployment (Wrangler, for debugging)

### 1. Log In and Create Resources

```bash
npx wrangler login

# Create the D1 database and note the database_id
npx wrangler d1 create fiammetta_d1

# Create the KV namespace and note the id
npx wrangler kv namespace create fiammetta-proxy
```

### 2. Configure worker/wrangler.toml

Fill in the IDs from the previous step:

```toml
name = "fiammetta_worker"
main = "src/index.ts"
compatibility_date = "2025-04-02"
compatibility_flags = ["nodejs_compat"]

[placement]
mode = "smart"

[vars]
DB_TYPE = "d1"                     # or tidb / pg

[[d1_databases]]
binding = "DB"
database_name = "fiammetta_d1"
database_id = "your-d1-database-id"

[[kv_namespaces]]
binding = "KV"
id = "your-kv-namespace-id"

[triggers]
crons = ["0 */6 * * *", "0 */1 * * *", "0 3 * * *"]
```

### 3. Initialize the Database

```bash
npx wrangler d1 execute fiammetta_d1 --file=init.sql --remote
```

(`init.sql` lives at the project root.)

### 4. Build and Deploy the Worker

```bash
npm run build:cf
cd worker
npx wrangler deploy --config wrangler.toml
```

### 5. Deploy Pages

```bash
npx wrangler pages deploy .open-next --project-name fiammetta-watcher --branch main
```

> Deploy the `.open-next` directory, **not** `.open-next/assets` — deploying assets degrades to a static site and the admin panel returns 404.

### 6. Configure Pages Credentials and Bindings

Pages needs database/cache bindings and admin credentials. Export the resource IDs created in step 1 and the admin credentials, then run:

```bash
export CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=xxx
# D1_ID / KV_ID are the IDs output when creating the resources in step 1
# (post requires KV_ID or it fails; post-deploy uses D1_ID/KV_ID to configure
# the Pages bindings — missing IDs will wipe the Pages D1/KV bindings)
export D1_ID=your-d1-database-id KV_ID=your-kv-namespace-id
# Admin credentials (post writes them into the Pages Secrets; deployment fails without ADMIN_PASSWORD)
export ADMIN_USERNAME=admin ADMIN_PASSWORD=your-admin-password
python3 deploy/init.py post
python3 deploy/init.py post-deploy
```

(Run `pip install requests` first when doing this locally. Alternatively, skip these commands and configure the bindings and env vars manually in Dashboard → Workers & Pages → project → Settings.)

## Scheduled Tasks

Scheduled tasks are deployed automatically with the Worker — no extra configuration needed. See [Cron Tasks](/en/api/cron) for the task list and business logic. View/edit frequencies in Dashboard → Worker → Settings → Triggers → Cron Triggers.

## Troubleshooting

### Frequent Failures on the Free Tier (CPU Timeout)

Workers Free allows **10ms CPU** per request. Proxying streaming AI requests easily exceeds this. For production, upgrade to Workers Paid (CPU limit defaults to 30s, up to 5 min) or switch to [Vercel](/en/deployment/vercel) / [EdgeOne](/en/deployment/edgeone).

### D1 Free Tier Limits

5GB storage, 5M row reads/day, 100k row writes/day. Usage stats and log archival consume rows — monitor if traffic is high (Dashboard → D1 → usage).

### Streaming Responses Interrupted

Common on the free tier. Note the 120-second limit is the app's default upstream request timeout (same on every platform); on the free tier the more common cause is the 10ms CPU limit (see above). Upgrade to a paid plan or switch platforms.

### Admin Panel 404 After Deploy

With Option 2, check that you deployed the `.open-next` directory (not `.open-next/assets`).

> More generic troubleshooting: [Troubleshooting](/en/deployment/troubleshooting).

## Related Docs

- [Architecture](/en/deployment/architecture)
- [Environment Variables](/en/deployment/env)
- [Wrangler docs](https://developers.cloudflare.com/workers/wrangler/)
