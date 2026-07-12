# Chat Completions

## Endpoint

```
POST /v1/chat/completions
```

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| model | string | Yes | Model name |
| messages | array | Yes | Message array |
| stream | boolean | No | Enable streaming |
| temperature | number | No | Temperature (0-2) |
| max_tokens | integer | No | Max generation tokens |

## Message Format

```json
{
  "role": "system",
  "content": "You are a helpful assistant."
}
```

Roles:
- `system` — System prompt
- `user` — User message
- `assistant` — Assistant response

## Request Example

```bash
curl -X POST https://example.com/v1/chat/completions \
  -H "Authorization: Bearer fwp-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Hello!"}
    ]
  }'
```

## Streaming

```bash
curl -X POST https://example.com/v1/chat/completions \
  -H "Authorization: Bearer fwp-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

## Response

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "gpt-4o",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help you?"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 20,
    "total_tokens": 30
  }
}
```

## Next Steps

