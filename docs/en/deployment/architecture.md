# Architecture

FWP is an AI gateway: it exposes an OpenAI-compatible proxy API outward, and provides an admin panel inward (manage API Keys, models, usage and logs). There are two deployment modes — which one you get depends on the platform you choose.

## The Two Modes

### Cloudflare Mode (managed, recommended)

```
Requests → proxy API + scheduled tasks (run by Cloudflare)
         → frontend + admin panel (hosted by Cloudflare)
                  ↓
              D1 database (built into Cloudflare)
```

- The proxy API and the 3 scheduled tasks (model discovery, key usage reset, log archival) all run on Cloudflare — they consume none of your own server resources
- The frontend and admin panel are also hosted on Cloudflare
- Data lives in Cloudflare's built-in D1 database — no external database needed within the free tier
- Scheduled tasks are built in and run automatically for free

### Self-Hosted Mode (Vercel / EdgeOne / your own server)

```
Requests → Next.js service
     ├── proxy API /v1/*
     ├── cron endpoints /api/cron/* (must be triggered externally)
     ├── admin panel
     └── frontend pages
              ↓
         TiDB / PostgreSQL (remote database)
```

- The whole application runs in one service (serverless functions on Vercel / EdgeOne, or your own server)
- You provide the database yourself: TiDB Cloud (free tier) or PostgreSQL, connected via a connection string
- Scheduled tasks have no built-in scheduler — an external service must call the endpoints on schedule (see each platform's guide)
- Rate-limit counters reset on service restarts (cold start) — expected, and it does not affect functionality

## Platform Differences at a Glance

| Item | Cloudflare | Vercel / EdgeOne | Own server |
|------|-----------|------------------|-----------|
| Database | built-in D1 (free) | self-provided TiDB / PostgreSQL | self-provided |
| Scheduled tasks | built-in, free | external scheduler (Vercel Cron needs Pro) | system cron |
| Login rate limit | survives restarts | resets on restart | resets on restart |

> Admin login rate limit: 5 failed attempts within 30 minutes temporarily blocks login — wait a while and try again.

## Related Docs

- [Deployment Guide](/en/deployment/) — platform comparison and selection
- [Cloudflare](/en/deployment/cloudflare)
- [Vercel](/en/deployment/vercel)
- [EdgeOne](/en/deployment/edgeone)
- [Environment Variables](/en/deployment/env)
