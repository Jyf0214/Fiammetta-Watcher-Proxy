# Platform Configuration

## Adding a Platform

Go to "Platform Management" in the admin panel and click "Add Platform".

## Configuration

| Field | Description |
|-------|-------------|
| Name | Custom identifier |
| Base URL | Platform API address |
| API Key | Platform authentication key |
| Type | OpenAI-compatible / Azure / Custom / Anthropic |
| Priority | Higher number = higher priority |
| Weight | Routing distribution ratio |
| RPM Limit | Requests per minute limit |
| TPM Limit | Tokens per minute limit |

## Platform Types

The platform type determines the upstream protocol:

- **OpenAI-compatible**: OpenAI-compatible endpoints of most providers (OpenAI, Google, DeepSeek, etc.)
- **Azure**: Azure OpenAI service
- **Custom**: Custom OpenAI-compatible gateway
- **Anthropic**: Native Anthropic protocol, for the official Claude API, GitHub Copilot, and similar gateways

## Named Keys

Support multiple named keys per platform:

```json
[
  {"name": "Key 1", "key": "sk-xxx"},
  {"name": "Key 2", "key": "sk-yyy"}
]
```

## Advanced Settings

The advanced settings group provides these optional fields:

| Field | Description | Default |
|-------|-------------|---------|
| Forward Headers | Downstream request headers to forward to upstream (JSON array) | empty |
| Inject stream_options | Whether to auto-inject `stream_options` (turn off when the upstream rejects it) | on |
| Platform Whitelist | When enabled, the platform is never banned on 429 — it is only degraded for 2 minutes (per-key error-count auto-disable is unaffected) | off |
| Override UA | When enabled, replaces the User-Agent sent to upstream with the custom UA (requires Custom UA to be filled in; takes priority over UA in Extra Headers) | off |
| Custom UA | Override the User-Agent sent to upstream | empty |
| Extra Headers | Additional request headers sent to upstream (JSON object, max 20) | empty |

> See the [Admin Panel Usage Guide](/en/guide/usage) for full details on each field, and the [API Reference](/en/api/) for the platform API field definitions.

## Enable/Disable

Platforms can be toggled on/off. Disabled platforms won't receive requests.

## Next Steps

- [API Key Management](/en/guide/api-key) — create and manage API keys
- [Model Mapping](/en/guide/model-map) — configure model name mappings
- [API Reference](/en/api/) — endpoint usage
- [Environment Variables](/en/deployment/env) — full env var reference

