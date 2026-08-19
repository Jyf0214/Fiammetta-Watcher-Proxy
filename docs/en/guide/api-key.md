# API Key Management

## Creating an API Key

Go to "API Key Management" in the admin panel and click "Add Key".

## Configuration

| Field | Description |
|-------|-------------|
| Name | Custom identifier |
| Token Quota | Total token usage limit (0 = unlimited) |
| Call Limit | Total call count limit (0 = unlimited) |
| RPM Limit | Requests per minute limit |
| TPM Limit | Tokens per minute limit |
| Reset Period | monthly / daily / never (default: monthly) |
| Expiration | Optional; requests are rejected with 401 after expiry (no input field in the admin UI yet — set it via import or API) |

## Auto Reset

Usage resets based on `resetPeriod`, triggered by scheduled tasks:

- `monthly` — Resets on the 1st of each month
- `daily` — Resets at midnight
- `never` — Never resets

Resets are executed by scheduled tasks: on Cloudflare the Worker's built-in Cron checks hourly; on Docker the in-container timer runs it automatically; other deployments must call `/api/cron/key-reset` externally (see [Cron Tasks](/en/api/cron), protected by `CRON_SECRET`). Without any scheduled invocation, usage is never reset.

## Next Steps

- [Platform Configuration](/en/guide/platform) — configure upstream AI service providers
- [System API Key](/en/guide/system-key) — admin API authentication
- [API Reference](/en/api/) — call endpoints with an API key

