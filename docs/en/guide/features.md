# Features

## Multi-platform Access

A unified API entry for major AI platforms (OpenAI-compatible APIs connect directly; native Anthropic protocol is converted automatically):

- **OpenAI** — GPT-4o, GPT-4, GPT-3.5
- **Anthropic** — Claude 3.5, Claude 3
- **Google** — Gemini 1.5, Gemini Pro
- **Others** — Any OpenAI-compatible API

## Smart Routing

- **Priority routing**: Higher number = higher priority
- **Weight routing**: Distribute requests by weight ratio
- **Failover**: Automatically switch when a platform fails
- **Circuit breaking**: Pause requests after consecutive failures
- **Half-open probing**: Auto-detect recovery after cooldown

## Usage Monitoring

- **Real-time dashboard**: Requests, tokens, TTFT latency
- **Trend charts**: Hourly/daily trends with single-day hourly view
- **Platform comparison**: Request distribution and performance by platform
- **Log archiving**: Detailed logs older than 30 days auto-aggregated

## Cost Tracking

- **Dual-channel pricing**: Upstream-reported costs trusted first; price-table estimation as fallback
- **Price table management**: USD-per-million-token prices with one-click LiteLLM community import
- **Cost reports**: Dashboard total, per-Key/per-platform cost columns, per-request detail
- See [Cost Tracking](/en/guide/cost)

## Alert Notifications

- **Webhook push**: Five event types — key bans, circuit breaker trips/degradation, all-platform outage, 80% quota warnings
- **Concurrent channels**: Works with Telegram Bot / Bark / ServerChan and similar services
- **Anti-spam**: Cooldown deduplication per event type; sending is fully side-effect-free for requests
- See [Alert Notifications](/en/guide/notifications)

## API Key Management

- **Multi-level quotas**: Token limits, call limits, RPM/TPM
- **Auto-reset**: Monthly/daily/never reset cycles
- **Expiry management**: Set expiration dates, auto-disable
- **Quota warnings**: Push alert when a key reaches 80% of its quota

## Outbound Proxy

- **Subscription pull**: Bulk-import proxy lists from subscription URLs with group management and scheduled sync
- **Health checks**: Periodic probes mark unreachable nodes automatically
- **Fine-grained binding**: Proxy-group routing at both platform and individual-key level
- **Multi-protocol**: HTTP / SOCKS4 / SOCKS5
- See [Outbound Proxy](/en/guide/upstream-proxy)

## Security

- **JWT authentication**: Admin login protection, optional TOTP two-factor verification (authenticator app codes)
- **Rate limiting**: Platform and key-level RPM/TPM limits
- **Security headers**: CSP, HSTS, X-Frame-Options, etc.
- **Bot blocking**: Prevent search engines and AI crawlers

## Data Management

- **Export**: Complete system config and business data export
- **Import**: Support migration and backup restoration
- **Scheduled backup**: Daily AES-GCM-encrypted config snapshots pushed to your own receiver
- **Audit logs**: Record all admin operations

## Developer Debugging

- **Playground**: Send real requests to any model from the admin panel through the full proxy chain
