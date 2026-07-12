# Responses

## Endpoint

```
POST /v1/responses
```

## Description

OpenAI Responses API proxy, supports both streaming and non-streaming responses. This API provides more flexible interaction than Chat Completions, with support for tool calls and multi-turn conversation management.

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| model | string | Yes | Model name |
| input | string/array | Yes | Input content |
| stream | boolean | No | Enable streaming |
| tools | array | No | Tool definitions array |

## Request Example

```bash
curl -X POST https://fwp.example.com/v1/responses \
  -H "Authorization: Bearer fwp-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "input": "Hello!",
    "stream": false
  }'
```

## Streaming

```bash
curl -X POST https://fwp.example.com/v1/responses \
  -H "Authorization: Bearer fwp-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "input": "Hello!",
    "stream": true
  }'
```

## Next Steps

