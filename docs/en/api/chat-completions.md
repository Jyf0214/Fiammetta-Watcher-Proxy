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

Streaming responses use SSE (Server-Sent Events) format with `Content-Type: text/event-stream`; each chunk is a `data: {json}` line, ending with `data: [DONE]`:

```text
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

Gateway-level errors (e.g. 401 auth failure, 429 rate limit, 400 invalid request) are returned as a JSON error body with the corresponding HTTP status code before the SSE stream opens; they do not appear in the stream. Only errors reported by the upstream inside the stream after the 2xx response has started streaming are passed through as `data: {...}` blocks. Clients should handle both forms: the JSON error body before the stream opens and in-stream error blocks after it starts.

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

