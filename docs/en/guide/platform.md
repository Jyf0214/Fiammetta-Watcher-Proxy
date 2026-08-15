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

## Enable/Disable

Platforms can be toggled on/off. Disabled platforms won't receive requests.

## Next Steps

