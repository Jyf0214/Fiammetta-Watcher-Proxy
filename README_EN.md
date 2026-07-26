# Fiammetta Watcher Proxy

English | [简体中文](README.md)

LLM API proxy with multi-platform load balancing, circuit breaker recovery, and SSE streaming. Deployed on Cloudflare's global edge network.

## Features

- **Multi-platform load balancing** — Routes across upstream API platforms by priority, weight, and health status
- **Circuit breaker recovery** — Auto-failover on platform failure, auto-recovery when healthy
- **SSE streaming** — Full support for streaming responses from major LLM platforms
- **Admin dashboard** — Visual management for platforms, keys, model mappings, logs, and audit trails
- **Scheduled tasks** — Auto-reset key usage, auto-discover platform models, auto-archive logs
- **Multi-database support** — D1 / TiDB Cloud / PostgreSQL, runtime auto-switching

## Architecture

```
User request → Cloudflare Worker (proxy v1/* + Cron tasks)
             → Cloudflare Pages (admin dashboard + API routes)
             → D1 / TiDB / PostgreSQL (via lib/prisma.ts unified factory)
             → KV namespace (login rate limiting + circuit breaker state)
```

## Database Support

Select database via `DB_TYPE` env var. `lib/prisma.ts` unified factory switches adapters automatically:

| DB_TYPE | Database | Adapter | Protocol |
|---------|----------|---------|----------|
| `d1` (default) | Cloudflare D1 | `@prisma/adapter-d1` | D1 Binding |
| `tidb` | TiDB Cloud Serverless | `@tidbcloud/prisma-adapter` | HTTP |
| `pg` | PostgreSQL direct | `@prisma/adapter-pg` | TCP |
| `hyperdrive` | ~~PostgreSQL via Hyperdrive~~ | ~~`@prisma/adapter-pg`~~ | ~~TCP (pooled)~~ |

> ⚠️ `hyperdrive` deprecated — `pg.Pool` is incompatible with Hyperdrive's transaction mode, causing requests to alternate strictly between success/failure. The recommended `postgres.js` driver cannot be bundled by OpenNext.

> **TiDB note:** TiDB Cloud on Cloudflare Workers requires HTTP protocol (`@tidbcloud/prisma-adapter`), not TCP-based `@prisma/adapter-mariadb`, because Workers run on V8 Isolate without Node.js TCP Socket support. Free-tier Workers have CPU/request limits — batch log imports (multi-row writes) may time out.

## Deployment

### Option 1: GitHub Actions (Recommended)

Push to `feat/cloudflare-workers` branch triggers automatic deployment:

1. **Init resources (pre)** — `deploy/init.py pre` creates D1/KV + replaces placeholders + writes DB_TYPE
2. **Install deps** — `npm install` + generate multi-dialect Prisma Client
3. **Validate config** — `deploy/init.py check` verifies schema files and build artifacts
4. **Build** — `npm run build:cf` (OpenNext build + asset staging)
5. **Deploy Worker** — `wrangler deploy` (API proxy + Cron)
6. **Init bindings & secrets (post)** — `deploy/init.py post` creates Pages + bindings + sets all Secrets
7. **Deploy Pages** — `wrangler pages deploy .open-next` (admin dashboard)

Configure these in GitHub repo Settings → Secrets:

| Secret | Description |
|--------|-------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token (Edit permission) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |
| `ADMIN_USERNAME` | Admin username |
| `ADMIN_PASSWORD` | Admin password |
| `DB_TYPE` | Database type (`d1` / `tidb` / `pg` / `hyperdrive`, default `d1`) |
| `DATABASE_URL` | External database URL (required for TiDB/PG, not needed for D1) |

### Option 2: Manual Deployment

#### Prerequisites

- Node.js 22+
- Python 3.12+
- Cloudflare account + API Token

#### Steps

```bash
# 1. Install dependencies
npm install

# 2. Login to Wrangler (or set CLOUDFLARE_API_TOKEN env var)
npx wrangler login

# 3. Init resources (create D1/KV + replace placeholders + write DB_TYPE)
python3 deploy/init.py pre

# 4. Validate Prisma multi-dialect config
python3 deploy/init.py check

# 5. Build
npm run build:cf

# 6. Deploy Worker
cd worker && npx wrangler deploy && cd ..

# 7. Init bindings & secrets (Pages bindings + all Secrets)
python3 deploy/init.py post

# 8. Deploy Pages
npx wrangler pages deploy .open-next --project-name fiammetta-watcher --branch main
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ADMIN_USERNAME` | Admin username |
| `ADMIN_PASSWORD` | Admin password |
| `JWT_SECRET` | JWT signing secret (auto-generated if empty) |
| `DB_TYPE` | Database type: `d1` (default) / `tidb` / `pg` / `hyperdrive` |
| `DATABASE_URL` | External database URL (required for TiDB/PG, D1 connects via binding) |

## Development

```bash
npm run dev          # Local dev
npm run build        # Next.js build
npm run build:cf     # Cloudflare build
npm run preview      # Cloudflare local preview
npm run test         # Run tests
```

## Tech Stack

- **Runtime**: Cloudflare Workers + Pages (OpenNext)
- **Framework**: Next.js 16 + React 19
- **Database**: Cloudflare D1 / TiDB Cloud / PostgreSQL (Prisma 7 ORM + Driver Adapters)
- **Cache**: Cloudflare KV
- **UI**: Ant Design 6 + Tailwind CSS
- **Charts**: Recharts
- **Auth**: JWT (jose)

## License

[Apache License 2.0](LICENSE)

## Disclaimer

This is an independently developed open-source project with no affiliation, sponsorship, or endorsement from any LLM service provider (including but not limited to OpenAI, Anthropic, Google, etc.).

This project only provides API request forwarding. It assumes no legal responsibility for any request content, response content, or usage behavior forwarded through this project. Users must ensure their usage complies with the connected platform's terms of service and applicable laws.

This project is provided "as is" without any express or implied warranties. The author shall not be liable for any direct or indirect damages arising from the use of this project.
