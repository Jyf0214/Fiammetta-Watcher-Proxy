# Admin Panel Usage Guide

The FWP admin panel is organized into 4 sections: **Overview**, **Manage**, **Monitor**, and **System**.

## Dashboard (Overview)

The dashboard provides a global view of system status:

- **Platform stats**: Total platforms, active platforms, health distribution
- **Key stats**: Total keys, active keys
- **Request stats**: Total requests, error requests, success rate
- **Token stats**: Total token consumption
- **Performance**: Average TTFT, average request duration
- **Trend charts**: Mini trend charts for each metric
- **Recent events**: Latest system events

The dashboard auto-refreshes every 30 seconds. Supports grid view and detail view modes.

## Platform Management

Configure and manage upstream AI service providers.

### Adding a Platform

Click "Add Platform" and fill in:

| Field | Description | Required |
|-------|-------------|----------|
| Name | Custom identifier | Yes |
| Base URL | Platform API address (e.g. `https://api.openai.com`) | Yes |
| API Key | Platform authentication key | Yes |
| Additional Keys | Extra keys (JSON array), round-robin with main key | No |
| Platform Type | `openai` / `azure` / `custom` | Yes |
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

When multiple keys are configured (main + additional), FWP uses Round-Robin rotation to distribute requests evenly.

Additional keys format:

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
| Plan | Bind to a plan template (overrides custom values below) | No |
| Token Quota | Total token usage limit | No (default 0) |
| Call Limit | Total call count limit | No (default 0) |
| RPM Limit | Requests per minute limit | No (default 0) |
| TPM Limit | Tokens per minute limit | No (default 0) |
| Reset Period | `monthly` / `daily` / `never` | No (default monthly) |
| Expiry | Auto-disable after this date | No |

### Quota Rules

- Value of `0` means unlimited
- When `planId` is not set, custom values are used
- When `planId` is set, plan template values take priority (unless custom values are explicitly set)

### Auto Reset

Based on `resetPeriod`:
- `monthly` — Resets on the 1st of each month
- `daily` — Resets daily at midnight
- `never` — No reset

### Key States

- **Enabled**: Accepts requests normally
- **Disabled**: Rejects all requests (returns 403)
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

1. System discovers available models from each platform every 10 minutes
2. View discovery results on the "Auto Model" page
3. Select specific models to include in the auto-routing pool
4. System generates an auto-model ID — when clients use this ID, FWP automatically selects the best platform and model
5. Failed auto-model requests are temporarily frozen for 3 minutes to prevent repeated failures

## Proxy Management

### Proxy Pools

Proxy pools are grouping units for HTTP proxy management.

| Field | Description |
|-------|-------------|
| Name | Unique pool identifier |
| Enabled | Whether the pool is active |

### Adding Proxies

| Field | Description |
|-------|-------------|
| Address | Proxy address, supports HTTP and SOCKS5 |
| Pool | Which pool to assign to |
| Enabled | Whether the proxy is active |

Address formats:
- HTTP: `http://user:pass@host:port`
- SOCKS5: `socks5://user:pass@host:port`

### Batch Import

Import multiple proxy addresses via text format, one per line.

### Proxy Health Check

| Status | Description | Routing Behavior |
|--------|-------------|-----------------|
| healthy | Working normally | Used normally |
| degraded | Performance degraded | 50% random skip |
| down | Unavailable | Completely skipped |

**Ban escalation**:
- 1st ban: 15 minutes cooldown
- 2nd ban: 5 hours cooldown
- 3rd+ ban: 24 hours cooldown

### Proxy Routing

1. Only healthy or degraded proxies are selected
2. Concurrent-aware rotation: different keys for the same platform prefer different proxies
3. Auto-retry on proxy failure (up to 2 different proxies)
4. Falls back to direct connection if all proxies fail

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
| Proxy | Proxy ID used (empty if direct) |
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

### System Events

Events are classified by severity:
- **info**: System initialization, config changes
- **warning**: Platform degradation, key quota approaching limits
- **error**: Platform failures, request anomalies
- **critical**: All platforms unavailable

## Data Management

### Export

Three export types:
- **System Config**: Platforms, API keys, model maps, proxies, plans
- **Business Data**: Request logs, daily stats, audit logs, system events
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
- Admin password change
