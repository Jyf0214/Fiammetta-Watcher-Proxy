# Responses

## Endpoint

```
POST /v1/responses
```

## Description

OpenAI Responses API proxy (next-gen request format unlocking advanced reasoning chain), supports both streaming and non-streaming responses. It offers more flexible interaction than Chat Completions with tool calling, multi-turn management and `reasoning` control.

This proxy does transparent forwarding for `v1/responses`: when downstream requests via this protocol, upstream is also requested via `v1/responses` with the same body and streaming events. It is isolated from the `v1/chat/completions` path.

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| model | string | Yes | Model name |
| input | string/array | Yes | Input (string or message array) |
| instructions | string | No | System instructions (chat system equivalent) |
| reasoning | object | No | Reasoning control, `{ effort: "high"|"medium"|"low"|"minimal", summary: "detailed"|"auto"|"concise" }` unlocks advanced thinking chain |
| stream | boolean | No | Enable streaming |
| tools | array | No | Tool definitions array |
| tool_choice | string/object | No | Tool selection strategy |
| text | object | No | Text output control, e.g. `{ verbosity: "high" }` |
| truncation | string | No | Long-context truncation strategy, `auto` |
| max_output_tokens | integer | No | Max output tokens (chat `max_tokens` equivalent) |
| store | boolean | No | Whether to store response |
| include | array | No | Additional output items to include |

## Request Example (Advanced Reasoning)

```bash
curl -X POST https://example.com/v1/responses \
  -H "Authorization: Bearer fwp-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5",
    "input": "Solve this math problem step by step",
    "reasoning": { "effort": "high", "summary": "detailed" },
    "stream": false
  }'
```

## Streaming

```bash
curl -X POST https://example.com/v1/responses \
  -H "Authorization: Bearer fwp-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5",
    "input": "Hello!",
    "reasoning": { "effort": "high" },
    "stream": true
  }'
```

Streaming events include `response.output_text.delta` etc. The gateway parses `usage` (`input_tokens`/`output_tokens`) and reasoning deltas for accounting and empty-completion detection.

## Request Templates

`v1/responses` uses a separate template type: in the admin panel choose **Responses API** to inject `instructions`, `reasoning`, `max_output_tokens`, `tools`, `truncation`, etc. (see Request Templates guide whitelist). `Chat` templates never affect `v1/responses` and vice versa; they are managed in separate pools.

Legacy templates without type are treated as `Chat` for backward compatibility.

## Next Steps

