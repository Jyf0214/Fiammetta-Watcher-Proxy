# API Reference

FWP provides OpenAI-compatible API endpoints.

## Base Information

- **Base URL**: `https://example.com/v1`
- **Auth**: Bearer Token (API Key)

## Authentication

All requests require the API Key in the `Authorization` header:

```
Authorization: Bearer fwp-your-api-key
```

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | Chat completions |
| `/v1/completions` | POST | Text completions |
| `/v1/embeddings` | POST | Text embeddings |
| `/v1/responses` | POST | OpenAI Responses API |
| `/v1/models` | GET | List available models |
| `/v1/models/{model}` | GET | Get single model info |
| `/v1/images/generations` | POST | Image generation |
| `/v1/images/edits` | POST | Image editing (multipart) |
| `/v1/images/variations` | POST | Image variations (multipart) |
| `/v1/audio/speech` | POST | Text-to-speech (TTS) |
| `/v1/audio/transcriptions` | POST | Speech-to-text (Whisper) |
| `/v1/audio/translations` | POST | Audio translation |

## Response Format

All responses follow OpenAI standard format:

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "gpt-4o",
  "choices": [...],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 20,
    "total_tokens": 30
  }
}
```

## Streaming

Supports Server-Sent Events (SSE) streaming:

```bash
curl -X POST https://your-domain.com/v1/chat/completions \
  -H "Authorization: Bearer fwp-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

## Error Responses

| Status | Description |
|--------|-------------|
| 400 | Invalid request parameters |
| 401 | Invalid or expired API key |
| 403 | API key disabled |
| 429 | Rate limit exceeded (RPM/TPM) |
| 500 | Internal server error |
| 502 | Upstream platform error |
| 503 | All platforms unavailable |

## Next Steps

