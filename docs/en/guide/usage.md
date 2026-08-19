# Admin Panel Usage Guide

The FWP admin panel is organized into 4 sections: **Overview**, **Manage**, **Monitor**, and **System**.

## Dashboard (Overview)

The dashboard provides a global view of system status:

- **Platform stats**: Active platforms
- **Key stats**: Active keys
- **Request stats**: Total requests
- **Token stats**: Total token consumption
- **Performance**: Average TTFT, average request duration
- **Trend charts**: Mini trend charts per stat card in detail view (requests, tokens, TPS; no trend for TTFT/duration without per-period data)

The dashboard auto-refreshes every 30 seconds. Supports grid view and detail view modes, and a manual refresh button.

## Platform Management

Configure and manage upstream AI service providers.

### Adding a Platform

Click "Add Platform" and fill in:

| Field | Description | Required |
|-------|-------------|----------|
| Name | Custom identifier | Yes |
| Base URL | Platform API address (e.g. `https://api.openai.com`) | Yes |
| API Keys | Auth keys, multiple allowed (one per line), rotated round-robin | Yes |
| Platform Type | `openai` / `azure` / `custom` / `anthropic` | Yes |
| Priority | Higher value = higher priority | No (default 0) |
| Weight | Load balancing weight, higher = more traffic | No (default 1) |
| RPM Limit | Max requests per minute | No |
| TPM Limit | Max tokens per minute | No |
| Forward Headers | Downstream request headers to forward to upstream (JSON array) | No |

The platform type determines the upstream protocol: choose `openai` for most providers' OpenAI-compatible endpoints, `anthropic` for the native Anthropic protocol (official Claude, GitHub Copilot, etc.). See "Platform Configuration".

### Advanced Settings

| Field | Description | Default |
|-------|-------------|---------|
| Forward Headers | Downstream request headers to forward to upstream (JSON array) | empty |
| Inject stream_options | Whether to auto-inject `stream_options` (turn off when the upstream rejects it) | on |
| Platform Whitelist | When enabled, neither the platform nor its keys are banned or auto-disabled on errors — they are only degraded for 2 minutes | off |
| Override UA | When enabled, replaces the User-Agent sent to upstream with the custom UA (requires Custom UA to be filled in; takes priority over UA in Extra Headers) | off |
| Custom UA | Override the User-Agent sent to upstream | empty |
| Extra Headers | Additional request headers sent to upstream (JSON object, max 20) | empty |

### Health Check & Circuit Breaker

- **healthy**: Normal operation
- **degraded**: Carries failure counts closer to the breaker threshold; still participates in allocation
- **down**: Circuit breaker triggered, no requests allocated

**Circuit breaker rules**:
- Triggers after 5 consecutive failures (retryable statuses 429/401/403/402 go through key ban and platform switching first and do not count directly; they only count when retries are exhausted and still failing)
- 60-second cooldown period
- After cooldown, enters half-open state with a probe request
- Success restores to healthy; failure re-triggers the breaker

### Key Rotation

A platform can have multiple keys (named-object JSON array). FWP uses Round-Robin rotation to distribute requests evenly across usable keys.

Key error counts accumulate and auto-disable the key: 429 → +1, 401 → +2, 402 → +5; at 5 the key is automatically disabled (a 429 also bans it for 5 minutes).

Key format:

```json
[
  {"name": "Key 1", "key": "sk-xxx"},
  {"name": "Key 2", "key": "sk-yyy"}
]
```

## API Key Management

API Keys are client credentials for accessing FWP.

### Creating an API Key

| Field | Description | Required |
|-------|-------------|----------|
| Name | Custom identifier | Yes |
| Token Quota | Total token usage limit | No (default 0) |
| Call Limit | Total call count limit | No (default 0) |
| RPM Limit | Requests per minute limit | No (default 0) |
| TPM Limit | Tokens per minute limit | No (default 0) |
| Reset Period | `monthly` / `daily` / `never` | No (default monthly) |
| Expiry | Requests are rejected with 401 after this date (the create form does not expose this field yet — set it via import or API) | No |

### Quota Rules

- Value of `0` means unlimited

### Auto Reset

Based on `resetPeriod`:
- `monthly` — Resets on the 1st of each month
- `daily` — Resets daily at midnight
- `never` — No reset

### Key States

The status column in the admin key list shows **Enabled / Disabled** only; "Expired" and "Over Limit" are runtime rejection behaviors, not visible statuses:

- **Enabled**: Accepts requests normally
- **Disabled**: Rejects all requests (returns 401)
- **Expired**: Requests are rejected after the expiry date (returns 401)
- **Over Limit**: Rejects requests when token or call limits are reached (returns 429)

## Model Mapping

Model mappings map client-requested model names to actual upstream model names (including `*` wildcard prefix matching, e.g. `gpt-4*`). There is **no dedicated management page** — maintain mappings via Export/Import JSON in the "Data Manager": add records (`alias` / `targetModel` / `platformId`) in the exported `modelMaps` array and import; mappings whose `alias` + platform combination already exists are skipped on import (the same alias mapped to different platforms is valid and not skipped).

### Configuration

| Field | Description |
|-------|-------------|
| Alias | Client-requested model name |
| Target Model | Actual model name forwarded to upstream |
| Platform | Limit to specific platform (empty = auto-select via router) |

### Usage Examples

| Alias | Target Model | Platform | Effect |
|-------|--------------|----------|--------|
| `gpt-4` | `gpt-4o` | — | Applies to all platforms |
| `claude-3` | `claude-3-5-sonnet` | Anthropic platform | Only applies to Anthropic |

### Use Cases

1. **Model upgrade**: Map old model names to new ones (e.g. `gpt-4` -> `gpt-4o`)
2. **Cost optimization**: Map expensive models to more cost-effective alternatives
3. **Compatibility**: Keep fixed model names on the client side while switching backends

### Auto Model

Auto Model is an advanced routing feature:

1. System discovers available models from each platform on a schedule (default every 6 hours; on Cloudflare this is driven by Cron, on Docker by the in-container timer, other deployments call `/api/cron/model-fetch` externally — see [Cron Tasks](/en/api/cron))
2. View discovery results on the "Auto Model" page
3. Select specific models to include in the auto-routing pool
4. Click "Enable Auto Model" on the "Auto Model" page to generate the auto-model ID (format `fwp-auto-model-xxxxxxxxxxxxxxxx`) — when clients use this ID, FWP automatically selects the best platform and model
5. Failed auto-model requests are temporarily frozen for 3 minutes to prevent repeated failures

::: warning
Model discovery calls the OpenAI-compatible `/models` endpoint — **Anthropic-type platforms do not support auto-discovery** (no `/models` endpoint in the native protocol); add platform models manually.
:::

## Usage Monitoring

### Usage Statistics

**Trend Charts**:
- View request and token usage trends by month/week/day
- Single-day hourly granularity supported

**Key Usage Tab**:
- Requests, token usage, average TTFT per API Key

**Platform Usage Tab**:
- Request distribution, token consumption, performance comparison per platform

### Request Logs

Every API request is logged with:

| Field | Description |
|-------|-------------|
| API Key | Key used |
| Platform | Target platform |
| Model | Requested model |
| Status Code | HTTP response code |
| Token Usage | Total tokens (prompt + completion) |
| TTFT | Time to first token (streaming only) |
| Duration | Total request duration |
| Error Message | Error details on failure |

Supports filtering by date range, API Key, status code (200/400/401/429/500/503) and error/normal state.

### Log Archival

- Detailed logs older than 30 days are automatically aggregated into daily statistics
- Aggregation dimensions: date + API Key + model (records carry their platform info), including request count, error count, token counts and average TTFT/duration/TPS
- Manual archival trigger available

### Audit Logs

Records all admin operations:
- Login/logout
- Platform create/update/delete
- API Key create/update/delete
- Data import/export

Each entry includes operator, action type, details, and client IP.

## Data Management

### Export

Three export types:
- **System Config**: Platforms, model maps, config entries
- **Business Data**: API keys, request logs, daily stats, audit logs
- **All**: Everything above

Exports as JSON files.

### Import

Import previously exported JSON files for:
- Server migration
- Backup restoration
- Configuration sync

Import uses a **preview-then-confirm** flow: it shows per-type counts and issues (missing required fields, duplicate unique keys, masked values), then imports in dependency order after confirmation. Import **only adds, never deletes** existing data; each type has a count cap — split into batches if exceeded. The result shows imported and skipped counts per data type (with skip reasons).

## System Settings

The "System" group contains three pages: Data Manager, System Keys, and Outbound Proxy (the latter is only available on Docker deployments). The database type and connection status are shown in the sidebar status bar (from `/api/health`, admin auth required).

## Related Docs

- [Deployment Guide](/en/deployment/) — deployment options and database choices
- [Environment Variables](/en/deployment/env) — full env var reference
- [API Reference](/en/api/) — endpoint usage
