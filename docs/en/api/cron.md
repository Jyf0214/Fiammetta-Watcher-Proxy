# Cron Tasks

FWP provides scheduled task endpoints for system maintenance. How they are triggered depends on the deployment:

- **Cloudflare deployment**: scheduled tasks run automatically via the Worker's built-in `scheduled` event (model discovery, key usage reset, log archival) — **no HTTP calls** to these endpoints are needed
- **Docker deployment**: scheduled tasks run automatically via an in-container timer (registered at app startup, no extra configuration) — **no HTTP calls** to these endpoints and **no `CRON_SECRET`** are needed
- **Other deployments** (Vercel / EdgeOne / Node.js): call these endpoints periodically from an external scheduler (Vercel Cron, Cron-job.org, UptimeRobot, or any HTTP scheduler)

## Endpoint List

| Endpoint | Function | Suggested Frequency | Description |
|----------|----------|---------------------|-------------|
| `GET/POST /api/cron/model-fetch` | Model Discovery | Every 6 hours | Auto-discover platform-supported models |
| `GET/POST /api/cron/key-reset` | Key Usage Reset | Hourly | Reset key monthly/daily usage counters (only cleared when the period starts) |
| `GET/POST /api/cron/log-archive` | Log Archival | Daily at 3:00 | Aggregate logs older than 30 days into daily statistics (the Docker in-container timer runs this at 3:10, offset from the hourly key reset) |
| `GET/POST /api/cron/proxy-health` | Outbound proxy health check | Every 5 minutes by default | Check outbound proxy connectivity (the Docker in-container timer runs this automatically; the interval can be customized to 1–1440 minutes (up to 24 hours) under Global settings on the outbound proxy page; active only when a proxy is configured). Skipped with `disabled: true` when device-level disabled (`UPSTREAM_PROXY_DISABLED=all`/`health`), so external schedulers don't misreport it as a failure |
| `GET/POST /api/cron/proxy-pull` | Outbound proxy list pull | Per-group interval | Pull the latest proxy list from each group's source URL (the Docker in-container timer triggers every minute and decides whether a group is due based on its auto-refresh toggle and interval of 1–20160 minutes (up to 14 days); active only for enabled groups with a pull source). Skipped with `disabled: true` when the outbound proxy is disabled entirely (`UPSTREAM_PROXY_DISABLED=all`) |

> On Docker the scheduled triggering is handled inside the container — no external calls needed. The endpoints remain available for manual triggering or external callers (requires `CRON_SECRET`).

## Authentication

If `CRON_SECRET` environment variable is set, all cron requests must include:

```
Authorization: Bearer <CRON_SECRET>
```

**`CRON_SECRET` is required**: if it is not configured, the endpoints are disabled (403) to prevent unauthenticated triggering. Once configured, make sure your scheduler sends the correct auth header, otherwise calls return 401.

> The Docker in-container timer calls the task functions directly — it does **not** go through these endpoints, so `CRON_SECRET` is **not** required there; it is only needed when calling the endpoints externally.

## Response Format

**Success**:

```json
{
  "success": true,
  "task": "model-fetch",
  "elapsed": 1234
}
```

**Failure**:

```json
{
  "success": false,
  "task": "model-fetch",
  "elapsed": 500,
  "error": "Task execution failed"
}
```

**Unknown Task**:

```json
{
  "error": "Not Found"
}
```

(Unknown-task and failure responses do not echo internal error details or the available-task list, to prevent information disclosure.)

## Usage Examples

### cURL

```bash
# Model discovery
curl -X GET https://your-domain/api/cron/model-fetch \
  -H "Authorization: Bearer your-CRON_SECRET"

# Key usage reset
curl -X GET https://your-domain/api/cron/key-reset \
  -H "Authorization: Bearer your-CRON_SECRET"

# Log archival
curl -X GET https://your-domain/api/cron/log-archive \
  -H "Authorization: Bearer your-CRON_SECRET"

# Outbound proxy health check (only for Docker deployments with a proxy configured)
curl -X GET https://your-domain/api/cron/proxy-health \
  -H "Authorization: Bearer your-CRON_SECRET"

# Outbound proxy list pull (only for groups with a pull source on Docker deployments)
curl -X GET https://your-domain/api/cron/proxy-pull \
  -H "Authorization: Bearer your-CRON_SECRET"
```

### Cloudflare Cron Triggers

In `worker/wrangler.toml`:

```toml
[triggers]
crons = ["0 */6 * * *", "0 */1 * * *", "0 3 * * *"]
```

(The Cloudflare deployment already ships with these crons in `worker/wrangler.toml` — no manual edit needed.)

### Vercel Cron

Create `vercel.json` in project root:

```json
{
  "crons": [
    { "path": "/api/cron/model-fetch", "schedule": "0 */6 * * *" },
    { "path": "/api/cron/key-reset",   "schedule": "0 */1 * * *" },
    { "path": "/api/cron/log-archive", "schedule": "0 3 * * *" }
  ]
}
```

### External Cron Services

Using [Cron-job.org](https://cron-job.org), [UptimeRobot](https://uptimerobot.com), etc.:

1. Create a scheduled task
2. Set URL to `https://your-domain/api/cron/model-fetch`
3. If auth is enabled, add header: `Authorization: Bearer your-CRON_SECRET`
4. Set frequency (model discovery every 6 hours, key reset hourly, log archival daily at 3:00)

## Task Details

### Model Discovery (model-fetch)

- Iterates all configured platforms, calls their `/v1/models` endpoint
- Writes discovered models to `platform_models` table
- Supports: OpenAI, Azure, custom OpenAI-compatible APIs (automatic model discovery is not available for Anthropic-type platforms; add models manually)
- Platform failures don't affect other platforms

### Key Reset (key-reset)

- Resets usage based on each key's `resetPeriod` setting
- `monthly`: Resets on the 1st of each month
- `daily`: Resets daily
- `never`: Never resets

### Log Archival (log-archive)

- Aggregates request logs older than 30 days from `request_logs` into `daily_stats`
- Aggregation dimensions: date + API Key + model
- Original detailed logs are deleted after archival to save storage
