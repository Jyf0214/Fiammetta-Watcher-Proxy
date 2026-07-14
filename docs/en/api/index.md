# API Reference

FWP provides OpenAI-compatible proxy APIs and admin panel APIs.

## Proxy API (V1)

### Base Information

- **Base URL**: `https://your-domain/v1`
- **Auth**: Bearer Token (API Key)

### Authentication

All requests require the API Key in the `Authorization` header:

```
Authorization: Bearer fwp-your-api-key
```

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | Chat completions (streaming supported) |
| `/v1/completions` | POST | Text completions |
| `/v1/embeddings` | POST | Text embeddings |
| `/v1/responses` | POST | OpenAI Responses API |
| `/v1/models` | GET | List available models |
| `/v1/models/{model}` | GET | Get single model info |
| `/v1/images/generations` | POST | Image generation |
| `/v1/images/edits` | POST | Image editing (multipart/form-data) |
| `/v1/images/variations` | POST | Image variations (multipart/form-data) |
| `/v1/audio/speech` | POST | Text-to-speech (TTS) |
| `/v1/audio/transcriptions` | POST | Speech-to-text (Whisper) |
| `/v1/audio/translations` | POST | Audio translation |

### Request Example

**Chat completions (streaming)**:

```bash
curl -X POST https://your-domain/v1/chat/completions \
  -H "Authorization: Bearer fwp-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

### Response Format

All responses follow OpenAI standard format:

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "gpt-4o",
  "choices": [
    {
      "index": 0,
      "message": {"role": "assistant", "content": "Hello!"},
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

Streaming responses use Server-Sent Events (SSE).

### Error Responses

| Status | Description |
|--------|-------------|
| 400 | Invalid request parameters |
| 401 | Invalid, expired, or disabled API key |
| 403 | API key disabled |
| 429 | Rate limit exceeded (RPM/TPM) |
| 500 | Internal server error |
| 502 | Upstream platform error |
| 503 | All platforms unavailable (circuit breaker or offline) |

## Admin API

Admin APIs require JWT authentication (via `admin_token` cookie).

### Authentication

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/auth` | POST | Admin login |
| `/api/admin/auth/change-password` | POST | Change password |
| `/api/admin/auth/reset-password` | POST | Reset password |

### Platform Management

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/platforms` | GET | List all platforms |
| `/api/admin/platforms` | POST | Create platform |
| `/api/admin/platforms/{id}` | PUT | Update platform |
| `/api/admin/platforms/{id}` | DELETE | Delete platform |
| `/api/admin/platforms/{id}/models` | GET | List platform discovered models |
| `/api/admin/platforms/{id}/models` | POST | Add platform model manually |
| `/api/admin/platforms/{id}/models` | PUT | Update platform model |
| `/api/admin/platforms/{id}/models` | DELETE | Delete platform model |

### API Key Management

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/keys` | GET | List all keys |
| `/api/admin/keys` | POST | Create key |
| `/api/admin/keys/{id}` | PUT | Update key |
| `/api/admin/keys/{id}` | DELETE | Delete key |

### Model Mapping

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/models` | GET | List all model maps |
| `/api/admin/models` | POST | Create model map |
| `/api/admin/models/{id}` | DELETE | Delete model map |

### Proxy Management

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/proxies` | GET | List all proxies |
| `/api/admin/proxies` | POST | Create proxy |
| `/api/admin/proxies/{id}` | PUT | Update proxy |
| `/api/admin/proxies/{id}` | DELETE | Delete proxy |
| `/api/admin/proxies/import` | POST | Batch import proxies |

### Proxy Pool Management

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/pools` | GET | List all proxy pools |
| `/api/admin/pools` | POST | Create proxy pool |
| `/api/admin/pools/{id}` | PUT | Update proxy pool |
| `/api/admin/pools/{id}` | DELETE | Delete proxy pool |

### Monitoring & Statistics

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/stats` | GET | System statistics overview |
| `/api/admin/usage` | GET | Usage data |
| `/api/admin/usage/trend` | GET | Usage trend (supports period parameter) |
| `/api/admin/usage/platform` | GET | Usage by platform |
| `/api/admin/logs` | GET | Request logs (paginated) |
| `/api/admin/logs/archive` | POST | Trigger log archival |
| `/api/admin/audit` | GET | Audit logs (paginated) |

### System Management

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/config` | GET | Get system config |
| `/api/admin/config` | PUT | Update system config |
| `/api/admin/export` | GET | Export data (supports type parameter) |
| `/api/admin/import` | POST | Import data |
| `/api/admin/debug` | GET | Debug information |

### Public API (No Auth Required)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/config` | GET | Get public config |
| `/api/setup/status` | GET | Check initialization status |
| `/api/setup/configure` | POST | First-time setup (database + admin) |
