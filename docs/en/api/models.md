# Models

## Endpoint

```
GET /v1/models
```

## Request

```bash
curl https://fwp.example.com/v1/models \
  -H "Authorization: Bearer fwp-your-api-key"
```

## Response

```json
{
  "object": "list",
  "data": [
    {
      "id": "gpt-4o",
      "object": "model",
      "created": 1234567890,
      "owned_by": "openai"
    },
    {
      "id": "claude-3-5-sonnet",
      "object": "model",
      "created": 1234567890,
      "owned_by": "anthropic"
    }
  ]
}
```

## Get Single Model

```
GET /v1/models/{model}
```

```bash
curl https://fwp.example.com/v1/models/gpt-4o \
  -H "Authorization: Bearer fwp-your-api-key"
```

## Next Steps

