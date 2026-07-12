# Environment Variables

All environment variables are configured in the `.env` file.

## Required

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | Database connection string | `postgresql://user:pass@localhost:5432/fwp` |
| `JWT_SECRET` | JWT signing secret (must change) | `your-super-secret-key` |
| `ADMIN_USERNAME` | Initial admin username | `admin` |
| `ADMIN_PASSWORD` | Initial admin password | `your-password` |

## Database

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | Database connection string | — |

### Connection Pool

FWP automatically adds these parameters:

- `connection_limit=5` — Max connections
- `pool_timeout=10` — Pool timeout (seconds)

Suitable for small environments (< 1GB RAM).

## Security

| Variable | Description | Default |
|----------|-------------|---------|
| `JWT_SECRET` | JWT signing secret | — (required) |
| `ADMIN_USERNAME` | Admin username | `admin` |
| `ADMIN_PASSWORD` | Admin password | — (set on first start) |

## Notifications (Optional)

| Variable | Description |
|----------|-------------|
| `WEBHOOK_URL` | Webhook notification URL |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token |
| `TELEGRAM_CHAT_ID` | Telegram Chat ID |

## Deployment

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Service listening port | `3000` |
| `NODE_ENV` | Runtime environment | `production` |

## Full Example

```env
# Database
DATABASE_URL=postgresql://fwp:password@localhost:5432/fwp

# Security
JWT_SECRET=my-super-secret-key-change-this
ADMIN_USERNAME=admin
ADMIN_PASSWORD=secure-password-here

# Deployment
PORT=3000
NODE_ENV=production

# Notifications (optional)
# WEBHOOK_URL=https://hooks.slack.com/xxx
# TELEGRAM_BOT_TOKEN=123456:ABC-DEF
# TELEGRAM_CHAT_ID=-100123456
```
