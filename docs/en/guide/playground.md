# Playground

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
