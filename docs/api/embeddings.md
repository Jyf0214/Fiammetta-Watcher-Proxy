# Embeddings

## 端点

```
POST /v1/embeddings
```

## 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| model | string | 是 | 嵌入模型名称 |
| input | string/array | 是 | 输入文本 |

## 请求示例

```bash
curl -X POST https://example.com/v1/embeddings \
  -H "Authorization: Bearer fwp-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "text-embedding-3-small",
    "input": "The quick brown fox jumps over the lazy dog"
  }'
```

## 响应格式

```json
{
  "object": "list",
  "data": [
    {
      "object": "embedding",
      "embedding": [0.0023064255, -0.009327292, ...],
      "index": 0
    }
  ],
  "model": "text-embedding-3-small",
  "usage": {
    "prompt_tokens": 8,
    "total_tokens": 8
  }
}
```

## 下一步

