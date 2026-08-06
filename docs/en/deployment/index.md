# Deployment Guide

FWP supports 4 deployment methods, grouped by target:

| Method | Architecture | Database | Scheduled Tasks |
|--------|--------------|----------|------------------|
| **Cloudflare Pages + Worker** | Worker handles proxy + scheduled tasks, Pages serves the frontend and admin panel | D1 (free, zero config) or TiDB/PG | Built into Cloudflare (free) |
| **Vercel / EdgeOne** | Serverless functions handle everything | TiDB / MariaDB / PostgreSQL (remote) | HTTP endpoints + external scheduler (Vercel Cron requires Pro) |
| **Node.js standalone** | Full server on your own machine | TiDB / MariaDB / PostgreSQL | HTTP endpoints + system cron |
| **Docker** | Containerized deployment | PostgreSQL / MySQL (incl. MariaDB) | HTTP endpoints + system cron |

## Platform Comparison

| Item | Cloudflare | Vercel | EdgeOne | Node.js / Docker |
|------|-----------|--------|---------|------------------|
| Free tier | Worker CPU 10ms/request (streaming AI proxy often exceeds this) | 100GB bandwidth/month | See official pricing | None (own resources) |
| Scheduled tasks | Built-in (free) | **Pro plan only** | External scheduler | System cron |
| Database | D1 (default, zero config) | TiDB/MariaDB/PG (remote) | TiDB/MariaDB/PG (remote) | TiDB/MariaDB/PG |
| Deploy trigger | Manual via web UI, or push `canary` | Connect Git repo in console | Manual via web UI | Manual |
| Best for | Zero-cost serverless | Existing Vercel / TiDB account | Tencent Cloud ecosystem | Full control |

> **Free-tier note**: Cloudflare Workers Free allows 10ms CPU per request. Proxying streaming AI requests easily exceeds this. For production, upgrade to Workers Paid (CPU limit defaults to 30s, up to 5 min) or choose another platform.

## How to Choose

1. **Zero-cost serverless** → [Cloudflare](/en/deployment/cloudflare) (D1 is free)
2. **Existing Vercel project or TiDB Cloud** → [Vercel](/en/deployment/vercel)
3. **Tencent Cloud user / needs China acceleration** → [EdgeOne](/en/deployment/edgeone) (new platform — verify the first deployment manually)
4. **Own server / VPS / intranet** → [Node.js standalone](/en/deployment/standalone) or [Docker](/en/deployment/docker)
5. **Only need the environment variables** → [Environment](/en/deployment/env)

> The whole deployment happens from the GitHub web UI: run the workflow manually and pick the target platform — no deployment mode configuration needed.

## Database Options

| Database | What to set | Platforms |
|----------|-------------|-----------|
| Cloudflare D1 | Nothing (`DB_TYPE=d1`) | Cloudflare only |
| TiDB Cloud | `DB_TYPE=tidb` + `DATABASE_URL` (MySQL protocol) | All |
| MariaDB / pure MySQL | `DB_TYPE=mariadb` + `DATABASE_URL` (mariadb protocol) | Non-CF (Vercel / EdgeOne / Node.js / Docker) |
| PostgreSQL | `DB_TYPE=pg` + `DATABASE_URL` | All |

## Related Docs

- [Architecture](/en/deployment/architecture) — the two deployment modes and platform differences
- [Environment Variables](/en/deployment/env)
- [Nginx](/en/deployment/nginx) — reverse proxy for self-hosted setups
