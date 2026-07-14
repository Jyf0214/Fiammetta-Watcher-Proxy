# Environment Variables

All environment variables are configured in the `.env` file.

## Required

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | Database connection string | See database config below |
| `JWT_SECRET` | JWT signing secret (HS256 mode, at least 32 random bytes) | Generate with `openssl rand -base64 32` |
| `ADMIN_USERNAME` | Initial admin username | `admin` |
| `ADMIN_PASSWORD` | Initial admin password | `your-strong-password` |

::: warning
Missing `JWT_SECRET` or `ADMIN_USERNAME` / `ADMIN_PASSWORD` prevents startup.
Missing `DATABASE_URL` allows startup with a redirect to the `/setup` page for web-based configuration.
:::

## Database

| Variable | Description | Format |
|----------|-------------|--------|
| `DATABASE_URL` | Database connection string | See examples below |

### PostgreSQL

```env
DATABASE_URL=postgresql://user:password@host:port/dbname?connection_limit=5&pool_timeout=10
```

### MySQL

```env
DATABASE_URL=mysql://user:password@host:port/dbname?connection_limit=5&pool_timeout=10
```

### TiDB Cloud

```env
DATABASE_URL=mysql://user:password@gateway01.xxxx.prod.aws.tidbcloud.com:4000/dbname?connection_limit=5&pool_timeout=10&sslaccept=accept_invalid_certs
```

### Connection Pool

Add these parameters to `DATABASE_URL` for small environments (< 1GB RAM):

- `connection_limit=5` — Max connections
- `pool_timeout=10` — Pool timeout (seconds)

## Security

| Variable | Description | Default |
|----------|-------------|---------|
| `JWT_SECRET` | JWT signing secret (HS256 mode) | — (required, or set `JWKS_KEY`) |
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

## Full Example

```env
# ===== Database =====
DATABASE_URL=postgresql://fwp:password@localhost:5432/fwp

# ===== Security =====
JWT_SECRET=my-super-secret-key-change-this
ADMIN_USERNAME=admin
ADMIN_PASSWORD=secure-password-here

# ===== Service =====
PORT=3000
NODE_ENV=production

# ===== Notifications (optional) =====
# TELEGRAM_BOT_TOKEN=123456:ABC-DEF
# TELEGRAM_CHAT_ID=-100123456
# SMTP_HOST=smtp.example.com
# SMTP_PORT=587
# SMTP_USER=user@example.com
# SMTP_PASS=your-smtp-password
# SMTP_FROM=noreply@example.com
```
