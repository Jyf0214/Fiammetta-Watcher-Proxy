# System API Key

System API Keys are credentials for **admin panel API authentication** (`Authorization: Bearer`). They are for programmatic access to admin APIs — **not** for the V1 proxy.

## Creating a System API Key

In the admin panel, go to "System API Key" (System group) and click "Create System Key". Only a name is required.

- The plaintext key is shown **only once** in the create response — copy and save it immediately; afterwards you can retrieve it again anytime via the copy button on the list row
- Format: `sk-sys-` + 48 hex chars (55 chars total)
- System API keys never expire

## Enable / Disable / Delete

- **Enable/Disable**: toggle the switch on the page (disabled keys are rejected immediately)
- **Delete**: remove the key permanently (irreversible)

## What System API Keys Can Access

| Area | Auth |
|------|------|
| Admin APIs (`/api/admin/*` + `/api/health`) | System API Key (`Bearer`) or admin JWT |
| V1 proxy (`/v1/*`) | **User API Key** only — system keys don't work here |
| Cron endpoints (`/api/cron/*`) | `CRON_SECRET` Bearer — system keys don't work here |

Typical uses: health checks, automated ops scripts, CI/CD, cross-system integrations (export/import, stats, log archival).

## Difference from User API Keys

| Dimension | System API Key | User API Key |
|-----------|----------------|--------------|
| Purpose | Admin API authentication | V1 proxy forwarding |
| Auth header | `Authorization: Bearer` only | `authorization` or `x-api-key` |
| Prefix | `sk-sys-` | none (user-defined) |
| Quotas | none (no token/call limits) | token/call/RPM/TPM limits |
| Expiry | never | optional `expiresAt` |
| On/off | `enabled` boolean | `status` field |

## Next Steps

- [API Key Management](/en/guide/api-key) — create user API keys for the V1 proxy
- [API Reference](/en/api/) — admin API endpoints
- [Deployment Guide](/en/deployment/) — health check examples using a system key
