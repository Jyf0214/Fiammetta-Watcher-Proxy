# Completions

## Endpoint

```
POST /v1/completions
```

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| model | string | Yes | Model name |
| prompt | string/array | Yes | Input prompt |
| stream | boolean | No | Enable streaming |
| temperature | number | No | Temperature (0-2) |
| max_tokens | integer | No | Max generation tokens |

## Request Example

```bash
curl -X POST https://example.com/v1/completions \
  -H "Authorization: Bearer fwp-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-3.5-turbo-instruct",
    "prompt": "Write a short poem about coding:",
    "max_tokens": 100
  }'
```

## Response

```json
{
  "id": "cmpl-xxx",
  "object": "text_completion",
  "created": 1234567890,
  "model": "gpt-3.5-turbo-instruct",
  "choices": [
    {
      "text": "Code flows like water...",
      "index": 0,
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 50,
    "total_tokens": 60
  }
}
```

## Next Steps

