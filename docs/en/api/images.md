# Images

## Endpoint

```
POST /v1/images/generations
```

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| model | string | No | Image model name |
| prompt | string | Yes | Image description |
| n | integer | No | Number of images (default 1) |
| size | string | No | Image size (default 1024x1024) |

## Request Example

```bash
curl -X POST https://example.com/v1/images/generations \
  -H "Authorization: Bearer fwp-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "dall-e-3",
    "prompt": "A cute robot reading a book",
    "n": 1,
    "size": "1024x1024"
  }'
```

## Response

```json
{
  "created": 1234567890,
  "data": [
    {
      "url": "https://...",
      "revised_prompt": "A cute robot..."
    }
  ]
}
```

## Image Edits / Variations

### Endpoint

```
POST /v1/images/edits
POST /v1/images/variations
```

### Parameters

> Note: the gateway supports **multipart file upload passthrough** — the `model` field is extracted from the form for routing, and the raw request bytes along with the `Content-Type` (including the boundary) are passed to the upstream as-is, without injecting template fields. JSON bodies are also supported and passed through as-is; usability depends on whether the upstream accepts JSON.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| image | string | Yes | Image file reference (JSON field; content format depends on the upstream) |
| model | string | Yes (edits) / No (variations) | Image model name |
| prompt | string | Yes (edits) / No (variations) | Edit instruction |
| n | integer | No | Number of images (default 1) |
| size | string | No | Image size (default 1024x1024) |

### Request Example

```bash
curl -X POST https://example.com/v1/images/edits \
  -H "Authorization: Bearer fwp-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "image": "https://example.com/input.png",
    "model": "gpt-image-1",
    "prompt": "Add a red hat",
    "n": 1
  }'
```

## Next Steps

