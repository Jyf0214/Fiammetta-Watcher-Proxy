# Playground & Failure Debugging

## Playground

Admin sidebar → **Playground**: send a real request to any model without leaving the admin panel, to verify platform configuration.

- **Model**: dropdown of all models discovered from enabled platforms (searchable)
- **API Key**: choose which key identity to send as (defaults to the latest active key)
- **Stream**: on by default; renders token-by-token and shows first-token latency, token usage and cost
- **Stop**: abort a streaming response at any time

Two design points worth knowing:

1. **Key plaintext never reaches the browser** — the selected key is injected server-side; the page only shows its name
2. **Full proxy chain** — the request follows exactly the same path as production traffic: routing, retries, rate limiting, logging, cost accounting. Playground usage counts toward quotas (audited as "Playground Call")

::: warning Deployment Compatibility
The playground loops back to this instance's own `/v1` endpoint server-side. A few serverless platforms forbid functions calling their own HTTP endpoints; in that case the playground returns an explicit error. Docker and self-hosted deployments are unaffected.
:::

## Failed Request Traces

Every **error row** in Request Logs has a "View" action showing:

| Field | Content |
|-------|---------|
| Request body | The original downstream JSON sent to the proxy (truncated at 16KB) |
| Response snippet | The upstream error response verbatim (truncated at 16KB) |

Both are one-click copyable for reproduction in a client or the playground.

### Coverage

Traces are written for:

- Upstream non-2xx errors (including final failures after retries; both OpenAI and Anthropic protocols)
- Network-level failures (connection/DNS errors — no response body, request body only)

Successful requests leave no trace. Trace data follows the log retention window (30 days) and is cleaned up by the log-archive job.

### Suggested Workflow

1. Filter errors in Request Logs, click "View" on the target row
2. Copy the request body into the Playground as a user message (or replay with curl)
3. Use the response snippet to tell upstream issues (auth/balance/params) apart from configuration issues (wrong model mapping, etc.)
