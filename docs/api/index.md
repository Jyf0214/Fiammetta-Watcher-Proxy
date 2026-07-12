# API 参考

FWP 提供 OpenAI 兼容的 API 接口。

## 基础信息

- **Base URL**: `https://your-domain.com/v1`
- **认证方式**: Bearer Token（API Key）

## 请求格式

所有请求都需要在 `Authorization` 头中携带 API Key：

```
Authorization: Bearer fwp-your-api-key
```

## 支持的端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/chat/completions` | POST | 聊天补全 |
| `/v1/completions` | POST | 文本补全 |
| `/v1/embeddings` | POST | 文本嵌入 |
| `/v1/images/generations` | POST | 图像生成 |
| `/v1/models` | GET | 获取模型列表 |

## 响应格式

所有响应都遵循 OpenAI 标准格式：

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

## 流式响应

支持 Server-Sent Events (SSE) 流式响应：

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

## 错误响应

| 状态码 | 说明 |
|--------|------|
| 400 | 请求参数错误 |
| 401 | API Key 无效或已过期 |
| 403 | API Key 已禁用 |
| 429 | 速率限制（RPM/TPM 超限） |
| 500 | 服务器内部错误 |
| 502 | 上游平台错误 |
| 503 | 所有平台不可用 |

## 下一步

- [Chat Completions](/api/chat-completions) — 聊天补全 API 详情
- [环境变量](/deployment/env) — 服务配置
