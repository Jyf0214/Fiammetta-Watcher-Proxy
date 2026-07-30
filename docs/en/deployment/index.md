# Deployment Guide

FWP supports multiple deployment methods. Choose the one that best fits your needs.

## Deployment Options Comparison

| Method | Use Case | Cost | Difficulty | Notes |
|--------|----------|------|------------|-------|
| [Cloudflare Pages + Worker](/en/deployment/cloudflare) | **Recommended for production** | Free tier available | ⭐ | Serverless, auto-scaling, global CDN |
| [Vercel / Netlify etc.](/en/deployment/vercel) | Serverless deployment | Free tier available | ⭐⭐ | Pages API handles `/v1/*` proxy and Cron |
| [Node.js Standalone](/en/deployment/standalone) | Self-hosted, dev/debug | Server required | ⭐⭐ | Traditional deployment, full control |
| [Docker](/en/deployment/docker) | Containerized deployment | Server required | ⭐ | Container-based, consistent environment |

## Architecture Modes

FWP uses a **dual-mode build architecture** that automatically switches based on the deployment platform.

### Cloudflare Mode (`CF_DEPLOY=true`)

```
Requests → Cloudflare Worker (/v1/* + Cron)
         → Cloudflare Pages (Frontend + Admin API)
```

- Worker handles `/v1/*` proxy requests and scheduled tasks
- Pages handles frontend and admin API
- Database: Cloudflare D1 (via Binding)

### Non-Cloudflare Mode (default)

```
Requests → Pages API / Next.js Server (/v1/* proxy + Cron + Admin API)
         → Frontend
```

- `/v1/*` proxy handled by Pages API routes (reusing Worker business modules)
- Cron tasks exposed via generic HTTP endpoints `/api/cron/*`, called by external services
- Database: TiDB / PostgreSQL (via `DATABASE_URL`)

::: tip Build Gate Mechanism
During build, `scripts/build-gate.sh` automatically handles routing: removes `pages/api/v1/` and `pages/api/cron/` during CF builds, restores them after. See [Architecture](/en/deployment/architecture).
:::

## Database Options

| Database | DB_TYPE | Connection | Best For |
|----------|---------|------------|----------|
| Cloudflare D1 | `d1` | D1 Binding (no URL needed) | CF deployments, serverless-native |
| TiDB Cloud | `tidb` | `DATABASE_URL` (MySQL protocol) | Free serverless MySQL |
| PostgreSQL | `pg` | `DATABASE_URL` | Full features, self-hosted |
| PostgreSQL via Hyperdrive | `pg` | Hyperdrive Connection String | PG on CF deployments |

::: warning Important
`DB_TYPE` is a core environment variable that determines which Prisma adapter to use. It must match your actual database.
:::

## Resource Requirements

### Serverless (CF / Vercel)

No resource management needed:
- Cloudflare Workers: Free plan 10ms CPU/request
- Cloudflare Pages: Free plan unlimited requests
- Vercel: Hobby plan 100GB bandwidth/month

### Self-Hosted

| Config | Minimum | Recommended |
|--------|---------|-------------|
| CPU | 1 vCPU | 2 vCPU |
| RAM | 512MB | 1GB+ |
| Disk | 10GB | 20GB |
| Node.js | 18.0 | 22.x LTS |

## Next Steps

- [Cloudflare Deployment](/en/deployment/cloudflare) — Recommended serverless deployment
- [Vercel Deployment](/en/deployment/vercel) — Non-CF platform deployment
- [Architecture](/en/deployment/architecture) — Dual-mode build architecture
- [Node.js Standalone](/en/deployment/standalone) — Self-hosted guide
- [Docker Deployment](/en/deployment/docker) — Containerized deployment
- [Environment Variables](/en/deployment/env) — Complete env var reference
- [Nginx Configuration](/en/deployment/nginx) — Reverse proxy and HTTPS
