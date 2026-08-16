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

> `DB_TYPE` and `DATABASE_URL` do **not** need to be configured as GitHub Secrets — at build time the EdgeOne CLI pulls them from the Makers project environment variables (writes `.env`), and the runtime uses the same set.

## 2. Trigger the Deployment

Fork the project to your GitHub account, then run the workflow manually from the Actions tab (enable it first if prompted):

Actions tab → Deploy workflow → Run workflow → **branch `canary`** (the fork's default branch is not `canary` — select it explicitly) → platform `edgeone` or `both` → Run workflow.

The CLI builds and uploads automatically — nothing else to do. During the build, the CLI runs dependency installation and `prisma generate`; for non-D1 databases (tidb/mariadb/pg) it also runs `prisma db push` to sync the schema (triggered automatically in CI).

## 3. Configure Runtime Environment Variables

Makers console → project → runtime environment variables (**configure before deploying** — shared by build time and runtime). See [Environment Variables](/en/deployment/env) for the full list and descriptions.

## 4. Scheduled Tasks

EdgeOne has no built-in scheduled tasks — call the `/api/cron/*` endpoints from an external scheduler (endpoints and suggested frequencies: [Cron Tasks](/en/api/cron)). Services: Cron-job.org, UptimeRobot.

## 5. Verify

| Check | Method |
|-------|--------|
| Health | `curl -H "Authorization: Bearer <system-api-key>" https://your-domain.com/api/health` → `{"status":"ok",...}` (admin auth required) |
| Proxy | `curl -H "Authorization: Bearer <user-api-key>" https://your-domain.com/v1/models` → a 200 model list is expected (all proxy endpoints require API Key auth) |
| Admin panel | `/admin`, log in with `ADMIN_USERNAME` / `ADMIN_PASSWORD` |
| Database | Open Models / Logs pages in the admin panel and confirm reads/writes work |

> The `<system-api-key>` above refers to a **System API Key** (`sk-sys-*`): after deployment, log in to the admin panel at `/admin` → "System Keys" page on the left and generate one. It is used for Bearer auth on system-level endpoints and is independent of user API Keys. `<user-api-key>` refers to a **user API Key** (`sk-` format), created on the "API Keys" page of the admin panel and used to authenticate V1 proxy endpoints.

## Troubleshooting

### Streaming / Proxy Timeouts

EdgeOne's first-deployment performance is not yet fully validated. If streaming breaks or times out, check the platform docs for function timeout and streaming support; if needed, switch to Vercel or Cloudflare.

> More generic troubleshooting: [Troubleshooting](/en/deployment/troubleshooting).

## Related Docs

- [Architecture](/en/deployment/architecture)
- [Environment Variables](/en/deployment/env)
- [Vercel](/en/deployment/vercel) — same runtime model
