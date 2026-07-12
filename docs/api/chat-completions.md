# Chat Completions

## 端点

```
POST /v1/chat/completions
```

## 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| model | string | 是 | 模型名称 |
| messages | array | 是 | 消息数组 |
| stream | boolean | 否 | 是否流式输出 |
| temperature | number | 否 | 温度参数 (0-2) |
| max_tokens | integer | 否 | 最大生成 Token 数 |

## 消息格式

```json
{
  "role": "system",
  "content": "You are a helpful assistant."
}
```

角色类型：
- `system` — 系统提示
- `user` — 用户消息
- `assistant` — 助手回复

## 请求示例

```bash
curl -X POST https://fwp.example.com/v1/chat/completions \
  -H "Authorization: Bearer fwp-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Hello!"}
    ]
  }'
```

## 流式响应

```bash
curl -X POST https://fwp.example.com/v1/chat/completions \
  -H "Authorization: Bearer fwp-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

## 响应格式

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "gpt-4o",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help you?"
      },
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

## 下一步

