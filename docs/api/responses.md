# Responses

## 端点

```
POST /v1/responses
```

## 说明

OpenAI Responses API 代理，支持流式和非流式响应。该 API 提供比 Chat Completions 更灵活的交互方式，支持工具调用和多轮对话管理。

## 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| model | string | 是 | 模型名称 |
| input | string/array | 是 | 输入内容 |
| stream | boolean | 否 | 是否流式输出 |
| tools | array | 否 | 工具定义数组 |

## 请求示例

```bash
curl -X POST https://fwp.example.com/v1/responses \
  -H "Authorization: Bearer fwp-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "input": "Hello!",
    "stream": false
  }'
```

## 流式响应

```bash
curl -X POST https://fwp.example.com/v1/responses \
  -H "Authorization: Bearer fwp-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "input": "Hello!",
    "stream": true
  }'
```

## 下一步

