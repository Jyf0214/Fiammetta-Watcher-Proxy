# Vercel Deployment

## Prerequisites

1. [Vercel account](https://vercel.com/signup)
2. Remote database: [TiDB Cloud](https://tidbcloud.com/) (free), MariaDB or PostgreSQL
3. GitHub repository

## 1. Import the Project

Vercel Dashboard → Add New → Project → import the repository from GitHub. Framework preset: **Next.js**; keep the default build command.

## 2. Configure Environment Variables

Configure in Settings → Environment Variables (`DB_TYPE` cannot be `d1`). See [Environment Variables](/en/deployment/env) for the full list and descriptions.

## 3. Deploy

Push the code — Vercel builds and deploys automatically. Note: you still need to set up the scheduled tasks afterwards (see the next section) — the free option requires an external scheduler.

## 4. Scheduled Tasks

See [Cron Tasks](/en/api/cron) for the business logic and endpoints of the 3 scheduled tasks.

### Option A: Vercel Cron (Pro plan required)

Not available on the Hobby plan. Create `vercel.json` in the project root (the repo does not ship one — create it yourself):

```json
{
  "crons": [
    { "path": "/api/cron/model-fetch", "schedule": "0 */6 * * *" },
    { "path": "/api/cron/key-reset",   "schedule": "0 */1 * * *" },
    { "path": "/api/cron/log-archive", "schedule": "0 3 * * *" }
  ]
}
```

With `CRON_SECRET` set, Vercel adds the auth header automatically.

### Option B: External Scheduler (free)

Call the `/api/cron/*` endpoints on a schedule (endpoints and suggested frequencies: [Cron Tasks](/en/api/cron)). Services: Cron-job.org, UptimeRobot, GitHub Actions (`schedule` trigger). GitHub Actions example:

```yaml
name: Cron Tasks
on:
  schedule:
    - cron: '0 */6 * * *'   # model discovery
    - cron: '0 * * * *'     # key reset
    - cron: '0 3 * * *'     # log archival
  workflow_dispatch:

jobs:
  cron:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger Cron
        run: |
          for task in model-fetch key-reset log-archive; do
            curl -fsS -X GET "https://${{ secrets.APP_URL }}/api/cron/$task" \
              -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}" || true
          done
```

## Database Options

### TiDB Cloud (free, recommended)

Sign up → create a Serverless cluster → copy the connection string:

```
mysql://user:pass@gateway01.xxxx.prod.aws.tidbcloud.com:4000/dbname?sslaccept=accept_invalid_certs
```

`DB_TYPE=tidb`.

### MariaDB / Pure MySQL

Any remotely accessible MariaDB or MySQL (cloud RDS / self-hosted):

```
DB_TYPE=mariadb
DATABASE_URL=mariadb://user:pass@host:port/dbname
```

### PostgreSQL

Any remotely accessible PostgreSQL (Neon / Supabase / Railway / self-hosted):

```
DB_TYPE=pg
DATABASE_URL=postgresql://user:pass@host:port/dbname
```

> On hosts with less than 1GB RAM, append `?connection_limit=5&pool_timeout=10` to the URL.

## Troubleshooting

### Rate Limit Resets on Cold Start

Expected: the rate-limit counter clears when a Serverless function cold-starts. It is best-effort and does not affect functionality.

### Cron Endpoints Return 401

With `CRON_SECRET` set, requests must carry `Authorization: Bearer <CRON_SECRET>`.

### Database Connection Timeout

- Confirm the database allows remote connections (TiDB Cloud does natively)
- Check firewall / whitelist rules

> More generic troubleshooting: [Troubleshooting](/en/deployment/troubleshooting).

## Related Docs

- [Architecture](/en/deployment/architecture)
- [Environment Variables](/en/deployment/env)
- [EdgeOne](/en/deployment/edgeone) — same runtime model
