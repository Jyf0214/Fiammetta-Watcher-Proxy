# Fiammetta Watcher Proxy

English | [简体中文](README.md)

> [!TIP]
> **Note: This project is under active development and unstable. Not recommended for production use.**
> The unstable version (current branch) also supports Docker build-based deployment, but no pre-built image is published yet — build it yourself.
> The stable version publishes a pre-built image `ghcr.io/jyf0214/fiammetta-watcher-proxy:latest` that can be pulled and run directly.

LLM API proxy with multi-platform load balancing, circuit breaker recovery, and SSE streaming. Deployable on Cloudflare, EdgeOne, Vercel, or your own server (Docker).

**Deployment guide: [https://jyf0214.github.io/Fiammetta-Watcher-Proxy/](https://jyf0214.github.io/Fiammetta-Watcher-Proxy/)**

## Features

- **Multi-platform load balancing** — Routes across upstream API platforms by priority, weight, and health status
- **Circuit breaker recovery** — Auto-failover on platform failure, auto-recovery when healthy
- **SSE streaming** — Full support for streaming responses from major LLM platforms
- **Admin dashboard** — Visual management for platforms, keys, model mappings, logs, and audit trails
- **Scheduled tasks** — Auto-reset key usage, auto-discover platform models, auto-archive logs
- **Multi-database support** — D1 / TiDB Cloud / MariaDB / PostgreSQL, runtime auto-switching

## Architecture

```
User request → Proxy entry (CF deployment: Worker proxies v1/* + Cron tasks; other platforms: Next.js routes)
             → Admin dashboard (Next.js 16 + API routes)
             → D1 / TiDB / MariaDB / PostgreSQL (lib/prisma.ts unified factory, switched by DB_TYPE)
             → Rate limiting & key ban state (KV on CF, in-process storage elsewhere)
```

## Database Support

Select database via `DB_TYPE` env var. `lib/prisma.ts` unified factory switches adapters automatically:

| DB_TYPE | Database | Adapter | Protocol | Platforms |
|---------|----------|---------|----------|-----------|
| `d1` (default) | Cloudflare D1 | `@prisma/adapter-d1` | D1 Binding | CF |
| `tidb` | TiDB Cloud Serverless | `@tidbcloud/prisma-adapter` | HTTP | All |
| `mariadb` | MariaDB / pure MySQL | `@prisma/adapter-mariadb` | TCP | Non-CF only (EdgeOne/Vercel/Docker/Node) |
| `pg` | PostgreSQL direct | `@prisma/adapter-pg` | TCP | All |

> **TiDB note:** TiDB Cloud on Cloudflare Workers requires HTTP protocol (`@tidbcloud/prisma-adapter`), not TCP-based `@prisma/adapter-mariadb`, because Workers run on V8 Isolate without Node.js TCP Socket support. The `mariadb` driver uses TCP and only works on **non-CF platforms** (CF builds exclude the mariadb driver from the bundle). Free-tier Workers have CPU/request limits — batch log imports (multi-row writes) may time out.

## Deployment

### Option 1: GitHub Actions

Push to the `canary` branch triggers Cloudflare deployment; EdgeOne deployments are manual only (requires `EO_PROJECT_NAME` / `EO_API_TOKEN` secrets). You can also manually select the platform (cf / edgeone / both) from the Actions page. Workflow steps:

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
| `DB_TYPE` | Database type (`d1` / `tidb` / `pg`, default `d1`) |
| `DATABASE_URL` | External database URL (required for TiDB/PG, not needed for D1) |
| `EO_PROJECT_NAME` | EdgeOne Makers project name (required for EdgeOne deployments) |
| `EO_API_TOKEN` | EdgeOne API Token (required for EdgeOne deployments) |

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

### Option 3: Docker Deployment

The unstable version (current branch) supports Docker build-based deployment. No pre-built image is published yet, so you need to build it yourself (pass `DB_TYPE` as a build arg to select the database dialect — must match the runtime):

```bash
# Built-in PostgreSQL, quick start
docker compose up -d --build

# External database (bring your own PostgreSQL / TiDB / MariaDB)
docker compose -f docker-compose.standalone.yml up -d --build
```

- Required env vars in `.env`: database password, `ADMIN_USERNAME` / `ADMIN_PASSWORD`, `JWT_SECRET`, etc.
- The container syncs the database schema on startup; admin is authenticated via env vars (no `/setup` onboarding page)
- The stable version's pre-built image `ghcr.io/jyf0214/fiammetta-watcher-proxy:latest` can be pulled and run directly — see the deployment guide for details

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ADMIN_USERNAME` | Admin username |
| `ADMIN_PASSWORD` | Admin password |
| `JWT_SECRET` | JWT signing secret (min 32 chars; auto-generated on Cloudflare CI deployments, must be set manually elsewhere) |
| `DB_TYPE` | Database type: `d1` (default) / `tidb` / `pg` (CF deployments); `mariadb` for non-CF platforms only |
| `DATABASE_URL` | External database URL (required for TiDB/MariaDB/PG, D1 connects via binding) |

## Development

```bash
npm run dev          # Local dev
npm run build        # Next.js build
npm run build:cf     # Cloudflare build
npm run preview      # Cloudflare local preview
npm run test         # Run tests
```

## Tech Stack

- **Runtime**: Cloudflare Workers + Pages (OpenNext) / EdgeOne / Vercel / Docker (Next.js standalone)
- **Framework**: Next.js 16 + React 19
- **Database**: Cloudflare D1 / TiDB Cloud / MariaDB / PostgreSQL (Prisma 7 ORM + Driver Adapters)
- **Cache**: Cloudflare KV (CF deployment)
- **UI**: Ant Design 6 + Tailwind CSS
- **Charts**: Recharts
- **Auth**: JWT (jose)

## License

[Apache License 2.0](LICENSE)

## Disclaimer

This is an independently developed open-source project with no affiliation, sponsorship, or endorsement from any LLM service provider (including but not limited to OpenAI, Anthropic, Google, etc.).

This project only provides API request forwarding. It assumes no legal responsibility for any request content, response content, or usage behavior forwarded through this project. Users must ensure their usage complies with the connected platform's terms of service and applicable laws.

This project is provided "as is" without any express or implied warranties. The author shall not be liable for any direct or indirect damages arising from the use of this project.
