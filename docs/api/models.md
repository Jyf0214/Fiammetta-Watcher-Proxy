# Models

## 端点

```
GET /v1/models
```

## 请求示例

```bash
curl https://fwp.example.com/v1/models \
  -H "Authorization: Bearer fwp-your-api-key"
```

## 响应格式

```json
{
  "object": "list",
  "data": [
    {
      "id": "gpt-4o",
      "object": "model",
      "created": 1234567890,
      "owned_by": "openai"
    },
    {
      "id": "claude-3-5-sonnet",
      "object": "model",
      "created": 1234567890,
      "owned_by": "anthropic"
    }
  ]
}
```

## 获取单个模型

```
GET /v1/models/{model}
```

```bash
curl https://fwp.example.com/v1/models/gpt-4o \
  -H "Authorization: Bearer fwp-your-api-key"
```

## 下一步

