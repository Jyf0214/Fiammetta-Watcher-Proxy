# API Key Management

## Creating an API Key

Go to "API Key Management" in the admin panel and click "Add Key".

## Configuration

| Field | Description |
|-------|-------------|
| Name | Custom identifier |
| Plan | Bind to a predefined plan template |
| Token Quota | Total token usage limit |
| Call Limit | Total call count limit |
| RPM Limit | Requests per minute limit |
| TPM Limit | Tokens per minute limit |
| Reset Period | monthly / daily / never |
| Expiration | Optional, auto-disable when expired |

## Plan Templates

Predefined quota standards for quick key creation:

- **Free** — 100K tokens / 1K calls
- **Standard** — 1M tokens / 10K calls
- **Pro** — 10M tokens / 100K calls

## Auto Reset

Usage resets based on `resetPeriod`:

- `monthly` — Resets on 1st of each month
- `daily` — Resets at midnight
- `never` — Never resets

## Next Steps

