# API Key Management

## Creating an API Key

Go to "API Key Management" in the admin panel and click "Add Key".

## Configuration

| Field | Description |
|-------|-------------|
| Name | Custom identifier |
| Token Quota | Total token usage limit |
| Call Limit | Total call count limit |
| RPM Limit | Requests per minute limit |
| TPM Limit | Tokens per minute limit |
| Reset Period | monthly / daily / never |
| Expiration | Optional, auto-disable when expired |

## Auto Reset

Usage resets based on `resetPeriod`:

- `monthly` — Resets on 1st of each month
- `daily` — Resets at midnight
- `never` — Never resets

## Next Steps

