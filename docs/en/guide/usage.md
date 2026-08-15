# Admin Panel Usage Guide

The FWP admin panel is organized into 4 sections: **Overview**, **Manage**, **Monitor**, and **System**.

## Dashboard (Overview)

The dashboard provides a global view of system status:

- **Platform stats**: Active platforms
- **Key stats**: Active keys
- **Request stats**: Total requests
- **Token stats**: Total token consumption
- **Performance**: Average TTFT, average request duration
- **Trend charts**: Mini trend charts for each metric

The dashboard auto-refreshes every 30 seconds. Supports grid view and detail view modes.

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

### Health Check & Circuit Breaker

- **healthy**: Normal operation
- **degraded**: Reduced allocation frequency
- **down**: Circuit breaker triggered, no requests allocated

**Circuit breaker rules**:
- Triggers after 5 consecutive failures
- 60-second cooldown period
- After cooldown, enters half-open state with a probe request
- Success restores to healthy; failure re-triggers the breaker

### Key Rotation

A platform can have multiple keys (named-object JSON array). FWP uses Round-Robin rotation to distribute requests evenly across keys.

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
| Expiry | Auto-disable after this date | No |

### Quota Rules

- Value of `0` means unlimited

### Auto Reset

Based on `resetPeriod`:
- `monthly` — Resets on the 1st of each month
- `daily` — Resets daily at midnight
- `never` — No reset

### Key States

- **Enabled**: Accepts requests normally
- **Disabled**: Rejects all requests (returns 401)
- **Expired**: Auto-disabled after expiry date
- **Over Limit**: Rejects requests when token or call limits are reached

## Model Mapping

Map client-requested model names to actual upstream model names.

### Configuration

| Field | Description |
|-------|-------------|
| Alias | Client-requested model name |
| Target Model | Actual model name forwarded to upstream |
| Platform | Limit to specific platform (empty = auto-select via router) |

### Use Cases

1. **Model upgrade**: Map old model names to new ones (e.g. `gpt-4` -> `gpt-4o`)
2. **Cost optimization**: Map expensive models to more cost-effective alternatives
3. **Compatibility**: Keep fixed model names on the client side while switching backends

### Auto Model

Auto Model is an advanced routing feature:

1. System discovers available models from each platform on a schedule (default every 6 hours; on Cloudflare this is driven by Cron)
2. View discovery results on the "Auto Model" page
3. Select specific models to include in the auto-routing pool
4. System generates an auto-model ID — when clients use this ID, FWP automatically selects the best platform and model
5. Failed auto-model requests are temporarily frozen for 3 minutes to prevent repeated failures

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

### Log Archival

- Detailed logs older than 30 days are automatically aggregated into daily statistics
- Aggregation dimensions: date + API Key + model
- Manual archival trigger available

### Audit Logs

Records all admin operations:
- Login/logout
- Platform create/update/delete
- API Key create/update/delete
- System config changes
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

Import results show imported and skipped counts per data type.

## System Settings

- System status overview (database connection, platform count, key count)
