# Audio

FWP supports three audio-related API endpoints, all compatible with the OpenAI Audio API format.

## Text-to-Speech (TTS)

### Endpoint

```
POST /v1/audio/speech
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| model | string | Yes | TTS model name (e.g. `tts-1`, `tts-1-hd`) |
| input | string | Yes | Text to convert |
| voice | string | Yes | Voice type (`alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`) |
| response_format | string | No | Output format (`mp3`, `opus`, `aac`, `flac`, default `mp3`) |
| speed | number | No | Speech speed (0.25-4.0, default 1.0) |

### Request Example

```bash
curl -X POST https://example.com/v1/audio/speech \
  -H "Authorization: Bearer fwp-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "tts-1",
    "input": "Hello, this is a test.",
    "voice": "alloy"
  }' \
  --output speech.mp3
```

## Speech-to-Text (Whisper)

### Endpoint

```
POST /v1/audio/transcriptions
```

### Parameters

> Note: the gateway supports **multipart file upload passthrough** — the `model` field is extracted from the form for routing, and the raw request bytes along with the `Content-Type` (including the boundary) are passed to the upstream as-is, without injecting template fields. JSON bodies are also supported and passed through as-is; usability depends on whether the upstream accepts JSON.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| file | string | Yes | Audio file reference (JSON field; content format depends on the upstream) |
| model | string | Yes | Model name (e.g. `whisper-1`) |
| language | string | No | Audio language (ISO-639-1 format) |
| prompt | string | No | Prompt text |
| response_format | string | No | Output format (`json`, `text`, `srt`, `verbose_json`, `vtt`) |

### Request Example

```bash
curl -X POST https://example.com/v1/audio/transcriptions \
  -H "Authorization: Bearer fwp-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "file": "https://example.com/audio.mp3",
    "model": "whisper-1"
  }'
```

## Audio Translation

### Endpoint

```
POST /v1/audio/translations
```

### Parameters

> Note: the gateway supports **multipart file upload passthrough** — the `model` field is extracted from the form for routing, and the raw request bytes along with the `Content-Type` (including the boundary) are passed to the upstream as-is, without injecting template fields. JSON bodies are also supported and passed through as-is; usability depends on whether the upstream accepts JSON.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| file | string | Yes | Audio file reference (JSON field; content format depends on the upstream) |
| model | string | Yes | Model name (e.g. `whisper-1`) |
| prompt | string | No | Prompt text |
| response_format | string | No | Output format |

### Request Example

```bash
curl -X POST https://example.com/v1/audio/translations \
  -H "Authorization: Bearer fwp-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "file": "https://example.com/audio.mp3",
    "model": "whisper-1"
  }'
```

## Next Steps

