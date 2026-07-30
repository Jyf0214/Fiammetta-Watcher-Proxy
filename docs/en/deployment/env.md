# Environment Variables

All environment variables are configured in the `.env` file (self-hosted) or in the platform console (Serverless).

## Core Configuration

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `DB_TYPE` | Database type: `d1` / `tidb` / `pg` | Yes | — |
| `DATABASE_URL` | Database connection string (not needed for `d1`) | Required for `tidb`/`pg` | — |
| `ADMIN_USERNAME` | Admin username | Yes | `admin` |
| `ADMIN_PASSWORD` | Admin password | Yes | — |
| `JWT_SECRET` | JWT signing secret (leave empty for auto-generation) | No | Auto-generated |

::: warning Important
- `DB_TYPE` is a core environment variable that determines which Prisma adapter to use. Must match your actual database.
- When `DB_TYPE=d1`, no `DATABASE_URL` is needed — D1 connects via Cloudflare Binding.
- `ADMIN_PASSWORD` is required. The admin account is created automatically on startup.
:::

## Database Configuration

### DB_TYPE Options

| Value | Database | Connection | Best For |
|-------|----------|------------|----------|
| `d1` | Cloudflare D1 | D1 Binding (no URL needed) | Cloudflare deployments |
| `tidb` | TiDB Cloud | `DATABASE_URL` (MySQL protocol) | Free serverless MySQL |
| `pg` | PostgreSQL | `DATABASE_URL` | Full features, self-hosted |

### DATABASE_URL Formats

**TiDB Cloud / MySQL**:

```env
DB_TYPE=tidb
DATABASE_URL=mysql://user:password@gateway01.xxxx.prod.aws.tidbcloud.com:4000/dbname?sslaccept=accept_invalid_certs
```

**PostgreSQL**:

```env
DB_TYPE=pg
DATABASE_URL=postgresql://user:password@host:port/dbname
```

**Cloudflare D1**:

```env
DB_TYPE=d1
# No DATABASE_URL needed — connects via Cloudflare Binding
```

### Connection Pool

For environments with less than 1GB RAM, append to `DATABASE_URL`:

```
?connection_limit=5&pool_timeout=10
```

## Security Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `JWT_SECRET` | JWT signing secret (HS256 mode) | Auto-generated |
| `JWKS_KEY` | JWKS/JWK/PEM format key (RS256 asymmetric, alternative to `JWT_SECRET`) | — |
| `ADMIN_USERNAME` | Admin username | `admin` |
| `ADMIN_PASSWORD` | Admin password | — (required) |

::: tip
At least one of `JWT_SECRET` or `JWKS_KEY` must be configured. `JWT_SECRET` uses symmetric encryption (HS256), suitable for most scenarios. `JWKS_KEY` uses asymmetric encryption (RS256), suitable for enterprise security requirements, with automatic format detection for JWKS, JWK, and PEM.
:::

## Service Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Service listening port | `3000` |
| `NODE_ENV` | Runtime environment | `production` |

## Cron Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `CRON_SECRET` | Cron task auth secret (Bearer Token) | — (no auth if unset) |

::: tip
`CRON_SECRET` protects `/api/cron/*` endpoints. When set, all cron requests must include `Authorization: Bearer <CRON_SECRET>` header.
:::

## Notifications (Optional)

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token for system alert notifications |
| `TELEGRAM_CHAT_ID` | Telegram Chat ID for notification target group |
| `SMTP_HOST` | SMTP server address |
| `SMTP_PORT` | SMTP server port |
| `SMTP_USER` | SMTP username |
| `SMTP_PASS` | SMTP password |
| `SMTP_FROM` | Sender email address |

## Examples by Deployment Type

### Cloudflare Deployment

Worker env vars (configured in Cloudflare Dashboard):

```env
DB_TYPE=d1
ADMIN_USERNAME=admin
ADMIN_PASSWORD=secure-password
CRON_SECRET=random-secret
```

Pages env vars (configured in Cloudflare Dashboard):

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=secure-password
```

### Vercel / Netlify Deployment

```env
DB_TYPE=tidb
DATABASE_URL=mysql://user:password@host:4000/dbname?sslaccept=accept_invalid_certs
ADMIN_USERNAME=admin
ADMIN_PASSWORD=secure-password
JWT_SECRET=
CRON_SECRET=random-secret
```

### Self-Hosted Deployment

```env
# ===== Database =====
DB_TYPE=pg
DATABASE_URL=postgresql://fwp:password@localhost:5432/fwp

# ===== Security =====
ADMIN_USERNAME=admin
ADMIN_PASSWORD=secure-password
JWT_SECRET=

# ===== Service =====
PORT=3000
NODE_ENV=production

# ===== Cron Auth (optional) =====
CRON_SECRET=random-secret

# ===== Notifications (optional) =====
# TELEGRAM_BOT_TOKEN=123456:ABC-DEF
# TELEGRAM_CHAT_ID=-100123456
# SMTP_HOST=smtp.example.com
# SMTP_PORT=587
# SMTP_USER=user@example.com
# SMTP_PASS=your-smtp-password
# SMTP_FROM=noreply@example.com
```

## Related Docs

- [Cloudflare Deployment](/en/deployment/cloudflare) — Cloudflare platform env var setup
- [Vercel Deployment](/en/deployment/vercel) — Vercel platform env var setup
- [Node.js Standalone](/en/deployment/standalone) — Self-hosted env var setup
