# Features

## Multi-platform Access

Support major AI platforms with a unified OpenAI-compatible format:

- **OpenAI** — GPT-4o, GPT-4, GPT-3.5
- **Anthropic** — Claude 3.5, Claude 3
- **Google** — Gemini 1.5, Gemini Pro
- **Others** — Any OpenAI-compatible API

## Smart Routing

- **Priority routing**: Lower number = higher priority
- **Weight routing**: Distribute requests by weight ratio
- **Failover**: Automatically switch when a platform fails
- **Circuit breaking**: Pause requests after consecutive failures
- **Half-open probing**: Auto-detect recovery after cooldown

## Usage Monitoring

- **Real-time dashboard**: Requests, tokens, TTFT latency
- **Trend charts**: Hourly/daily trends with single-day hourly view
- **Platform comparison**: Request distribution and performance by platform
- **Model statistics**: Call counts and token consumption per model
- **Log archiving**: Detailed logs older than 30 days auto-aggregated

## API Key Management

- **Multi-level quotas**: Token limits, call limits, RPM/TPM
- **Plan templates**: Predefined quota templates for quick key creation
- **Auto-reset**: Monthly/daily/never reset cycles
- **Expiry management**: Set expiration dates, auto-disable

## Security

- **JWT authentication**: Admin login protection
- **Rate limiting**: Platform and key-level RPM/TPM limits
- **Security headers**: CSP, HSTS, X-Frame-Options, etc.
- **Bot blocking**: Prevent search engines and AI crawlers

## Data Management

- **Export**: Complete system config and business data export
- **Import**: Support migration and backup restoration
- **Audit logs**: Record all admin operations
