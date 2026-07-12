# Platform Configuration

## Adding a Platform

Go to "Platform Management" in the admin panel and click "Add Platform".

## Configuration

| Field | Description |
|-------|-------------|
| Name | Custom identifier |
| Base URL | Platform API address |
| API Key | Platform authentication key |
| Type | OpenAI / Anthropic / Google, etc. |
| Priority | Lower number = higher priority |
| Weight | Routing distribution ratio |
| RPM Limit | Requests per minute limit |
| TPM Limit | Tokens per minute limit |

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

