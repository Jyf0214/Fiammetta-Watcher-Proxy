# Completions

## 端点

```
POST /v1/completions
```

## 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| model | string | 是 | 模型名称 |
| prompt | string/array | 是 | 输入提示 |
| stream | boolean | 否 | 是否流式输出 |
| temperature | number | 否 | 温度参数 (0-2) |
| max_tokens | integer | 否 | 最大生成 Token 数 |

## 请求示例

```bash
curl -X POST https://fwp.example.com/v1/completions \
  -H "Authorization: Bearer fwp-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-3.5-turbo-instruct",
    "prompt": "Write a short poem about coding:",
    "max_tokens": 100
  }'
```

## 响应格式

```json
{
  "id": "cmpl-xxx",
  "object": "text_completion",
  "created": 1234567890,
  "model": "gpt-3.5-turbo-instruct",
  "choices": [
    {
      "text": "Code flows like water...",
      "index": 0,
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 50,
    "total_tokens": 60
  }
}
```

## 下一步

