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

### Error Responses

| Status | Description |
|--------|-------------|
| 400 | Invalid request parameters |
| 401 | Invalid, expired, or disabled API key |
| 413 | Request body too large |
| 429 | Rate limit exceeded (RPM/TPM) |
| 500 | Internal server error (incl. no usable API key on any platform, model not found) |
| 502 | Upstream platform error (incl. empty upstream response) |
| 504 | Upstream request or response timeout |

## Cron API

On Docker deployments, scheduled tasks run automatically via the in-container timer; other deployments call them from an external scheduler. See [Cron Tasks](/en/api/cron).

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/cron/model-fetch` | GET/POST | Auto-discover platform models |
| `/api/cron/key-reset` | GET/POST | Reset key usage counters |
| `/api/cron/log-archive` | GET/POST | Archive old request logs |
| `/api/cron/proxy-health` | GET/POST | Outbound proxy health check (only active on Docker deployments with a proxy configured) |
| `/api/cron/proxy-pull` | GET/POST | Outbound proxy list pull (only active for groups with a pull source on Docker deployments) |

## Admin API

Admin APIs support two authentication methods: an admin JWT (via `admin_token` cookie) or a System API Key (`Authorization: Bearer <system-api-key>`, see [System Key](/en/guide/system-key)).

### Authentication

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/auth` | GET | Get current login status |
| `/api/admin/auth` | POST | Admin login |
| `/api/admin/auth` | DELETE | Admin logout |

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

Model mappings (`model_maps`) have no dedicated admin API — maintain them via [Data Management](/en/guide/usage) export/import.

### Request Templates

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/request-templates` | GET | List all request templates |
| `/api/admin/request-templates` | POST | Create request template |
| `/api/admin/request-templates` | PUT | Update request template (id in request body) |
| `/api/admin/request-templates` | DELETE | Delete request template (id in query or request body) |

### System Keys

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/system-keys` | GET | List all system keys |
| `/api/admin/system-keys` | POST | Create system key (key shown only once) |
| `/api/admin/system-keys/{id}` | PATCH | Enable/disable system key |
| `/api/admin/system-keys/{id}` | DELETE | Delete system key |

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
| `/api/health` | GET | Health check (db type + connection status, admin auth required) |

## Related Docs

- [Quick Start](/en/guide/quickstart) — local install and setup
- [Platform Configuration](/en/guide/platform) — configure upstream AI service providers
- [API Key Management](/en/guide/api-key) — create client credentials
- [Deployment Guide](/en/deployment/) — production deployment options and database choices
