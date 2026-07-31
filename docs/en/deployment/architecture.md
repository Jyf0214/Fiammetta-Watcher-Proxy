# Architecture

FWP uses a **dual-mode build architecture** — a single codebase automatically switches runtime modes based on the deployment platform.

## Dual-Mode Architecture

### Cloudflare Mode

When `DEPLOY_PLATFORM=cf` environment variable is present, the build system switches to Cloudflare mode:

```
┌─────────────────────────────────────────┐
│            Cloudflare Edge              │
│                                         │
│  Worker (/v1/* proxy + Cron tasks)      │
│       ↓                                 │
│  D1 Database (SQLite via Binding)       │
│                                         │
│  Pages (Frontend + Admin API + Setup)   │
│       ↓                                 │
│  D1 Database (shared)                   │
└─────────────────────────────────────────┘
```

- **Worker** handles all `/v1/*` proxy requests and Cron tasks
- **Pages** handles frontend static assets and admin API
- Both share the same D1 database (via Binding)

### Non-Cloudflare Mode (Default)

```
┌─────────────────────────────────────────┐
│         Node.js Server                  │
│                                         │
│  Next.js Server                         │
│  ├── /v1/* proxy (Pages API routes)     │
│  ├── /api/cron/* (HTTP endpoints)       │
│  ├── /api/admin/* (admin API)           │
│  └── Frontend static assets             │
│       ↓                                 │
│  TiDB / PostgreSQL (DATABASE_URL)       │
└─────────────────────────────────────────┘
```

- `/v1/*` proxy handled by Pages API route `pages/api/v1/[[...v1]].ts`
- Cron tasks exposed as HTTP endpoints via `pages/api/cron/[[...cron]].ts`
- Rate limiting uses in-memory Map (not KV)
- Database connects via `DATABASE_URL`

## Build Gate Mechanism

Shell scripts automatically handle route switching during build:

### build-gate.sh (Pre-Build)

```
DEPLOY_PLATFORM=cf → Moves pages/api/v1/ and pages/api/cron/ to .build-gate-tmp/
```

This ensures Cloudflare builds don't package v1 and cron routes into Pages (Worker handles them).

### Build Process

```bash
# build:cf script in package.json
DEPLOY_PLATFORM=cf bash scripts/build-gate.sh &&
node scripts/prepare-db.mjs &&
opennextjs-cloudflare build &&
DEPLOY_PLATFORM=cf bash scripts/build-gate-restore.sh
```

### build-gate-restore.sh (Post-Build)

```
DEPLOY_PLATFORM=cf → Restores files from .build-gate-tmp/ to original locations
```

::: warning
Route files must be restored after build. Otherwise, local dev and non-Cloudflare deployments will miss `/v1/*` and `/api/cron/*` routes.
:::

## Worker Module Reuse

Pages API routes (`pages/api/v1/[[...v1]].ts`) import Worker business modules via relative paths:

```typescript
import { validateApiKey } from "../../../worker/src/auth";
import { routeRequest } from "../../../worker/src/router";
import { getNextKey } from "../../../worker/src/platform-keys";
```

This design ensures:

- Business logic is maintained in one place (`worker/src/`)
- Pages API and Worker share identical routing, auth, and load-balancing logic
- Modules get database connections via `createDb()` factory, not direct D1 Binding

## Database Adapter Layer

FWP uses Prisma 7 multi-schema to support multiple databases:

```
prisma/
├── schema.d1.prisma     → Cloudflare D1 (wasm runtime)
├── schema.mysql.prisma  → TiDB / MySQL
└── schema.pg.prisma     → PostgreSQL
```

All three schemas define identical table structures but use different Generators and Runtimes:

| Schema | Generator | Runtime | Adapter |
|--------|-----------|---------|---------|
| `schema.d1.prisma` | `prisma-client-js` | `cloudflare` | `@prisma/adapter-d1` |
| `schema.mysql.prisma` | `prisma-client-js` | `node` | `mysql2` |
| `schema.pg.prisma` | `prisma-client-js` | `node` | `@prisma/pg-worker` |

`scripts/prepare-db.mjs` automatically selects the correct schema based on `DB_TYPE` and runs migration.

## Rate Limiting Implementation

| Environment | Storage | Persistent | Notes |
|-------------|---------|------------|-------|
| Cloudflare Worker | KV Namespace | ✅ Persistent | Survives cold starts |
| Pages API (non-CF) | In-memory Map | ❌ Non-persistent | Resets on cold start |

Both implementations share the same interface (`checkPlatformRpm`, `checkApiKeyRpm`, etc.) — only the underlying storage differs.

## Related Docs

- [Cloudflare Deployment](/en/deployment/cloudflare) — Cloudflare platform deployment guide
- [Vercel Deployment](/en/deployment/vercel) — Non-Cloudflare platform deployment
- [Environment Variables](/en/deployment/env) — Complete env var reference
