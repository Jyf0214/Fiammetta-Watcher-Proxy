# EdgeOne Deployment

EdgeOne (Tencent Cloud EdgeOne Makers): the proxy and scheduled tasks are handled by serverless functions, with a remote TiDB / MariaDB / PostgreSQL database.

::: warning New platform — verify the first deployment manually
EdgeOne Makers is relatively new. This guide is based on the current deployment flow. After the first deployment, manually verify the proxy, admin panel, and database connectivity.
:::

## Prerequisites

1. [EdgeOne Makers](https://console.cloud.tencent.com/edgeone) account and project (note the project name)
2. EdgeOne API Token (generated in the Makers console)
3. Remote database: TiDB Cloud, MariaDB or PostgreSQL (**required** — EdgeOne has no built-in database)
4. A GitHub account

## 1. Configure GitHub Secrets

Repo Settings → Secrets and variables → Actions:

| Secret | Description |
|--------|-------------|
| `EO_PROJECT_NAME` | EdgeOne Makers project name |
| `EO_API_TOKEN` | EdgeOne API Token |
| `DB_TYPE` | **Must be `tidb`, `mariadb` or `pg`** (not the default `d1`) |
| `DATABASE_URL` | Remote database URL |

> Secrets only apply at build time — the runtime environment variables must be configured in the Makers console (step 3).

## 2. Trigger the Deployment

Fork the project to your GitHub account, then run the workflow manually from the Actions tab (enable it first if prompted):

Actions tab → Deploy workflow → Run workflow → **branch `canary`** (the fork's default branch is not `canary` — select it explicitly) → platform `edgeone` or `both` → Run workflow.

The CLI builds and uploads automatically — nothing else to do.

## 3. Configure Runtime Environment Variables

Makers console → project → runtime environment variables:

```env
DB_TYPE=tidb                        # or pg / mariadb — never d1
DATABASE_URL=mysql://user:pass@host:4000/dbname?sslaccept=accept_invalid_certs
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-admin-password
JWT_SECRET=random-secret-32+chars   # required — login fails without it
CRON_SECRET=random-secret           # optional
```

## 4. Scheduled Tasks

EdgeOne has no built-in scheduled tasks. Use an external scheduler:

```bash
curl -X GET https://your-domain.com/api/cron/model-fetch \
  -H "Authorization: Bearer your-CRON_SECRET"
```

| Endpoint | Function | Suggested Frequency |
|----------|----------|---------------------|
| `/api/cron/model-fetch` | Model discovery | every 6h |
| `/api/cron/key-reset` | Key usage reset | hourly |
| `/api/cron/log-archive` | Log archival | daily 03:00 |

Services: Cron-job.org, UptimeRobot, GitHub Actions `schedule` trigger (example in [Vercel](/en/deployment/vercel)).

## 5. Verify

| Check | Method |
|-------|--------|
| Health | `curl -H "Authorization: Bearer <system-api-key>" https://your-domain.com/api/health` → `{"status":"ok",...}` (admin auth required) |
| Proxy | `curl https://your-domain.com/v1/models` (401 without API Key is expected) |
| Admin panel | `/admin`, log in with `ADMIN_USERNAME` / `ADMIN_PASSWORD` |
| Database | Open Models / Logs pages in the admin panel and confirm reads/writes work |

> The `<system-api-key>` above refers to a **System API Key** (`sk-sys-*`): after deployment, log in to the admin panel at `/admin` → "System Keys" page on the left and generate one. It is used for Bearer auth on system-level endpoints and is independent of user API Keys.

## Troubleshooting

### Streaming / Proxy Timeouts

EdgeOne's first-deployment performance is not yet fully validated. If streaming breaks or times out, check the platform docs for function timeout and streaming support; if needed, switch to Vercel or Cloudflare.

> More generic troubleshooting: [Troubleshooting](/en/deployment/troubleshooting).

## Related Docs

- [Architecture](/en/deployment/architecture)
- [Environment Variables](/en/deployment/env)
- [Vercel](/en/deployment/vercel) — same runtime model
