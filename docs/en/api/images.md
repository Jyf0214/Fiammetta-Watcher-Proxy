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

## Next Steps

