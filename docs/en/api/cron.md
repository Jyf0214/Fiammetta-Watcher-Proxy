# Cron Tasks

FWP provides 3 scheduled task endpoints for system maintenance. These are called periodically by external services (Cloudflare Cron Triggers, Vercel Cron, or any HTTP scheduler).

## Endpoint List

| Endpoint | Function | Suggested Frequency | Description |
|----------|----------|---------------------|-------------|
| `GET/POST /api/cron/model-fetch` | Model Discovery | Every 6 hours | Auto-discover platform-supported models |
| `GET/POST /api/cron/key-reset` | Key Usage Reset | Hourly | Reset key monthly/daily usage counters (only cleared when the period starts) |
| `GET/POST /api/cron/log-archive` | Log Archival | Daily at 3:00 | Aggregate logs older than 30 days into daily statistics |

## Authentication

If `CRON_SECRET` environment variable is set, all cron requests must include:

```
Authorization: Bearer <CRON_SECRET>
```

**`CRON_SECRET` is required**: if it is not configured, the endpoints are disabled (403) to prevent unauthenticated triggering. Once configured, make sure your scheduler sends the correct auth header, otherwise calls return 401.

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
curl -X GET https://your-domain/api/cron/model-fetch \
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
