# Responses

## 端点

```
POST /v1/responses
```

## 说明

OpenAI Responses API 代理（新一代请求格式，解锁高阶思维链），支持流式和非流式响应。该 API 提供比 Chat Completions 更灵活的交互方式，支持工具调用、多轮对话管理与 `reasoning` 推理控制。

本代理对 `v1/responses` 做透明转发：当下游按此协议请求时，上游也按 `v1/responses` 请求，请求体与流式事件原样透传；与 `v1/chat/completions` 链路分离，互不影响。

## 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| model | string | 是 | 模型名称 |
| input | string/array | 是 | 输入内容（字符串或消息数组） |
| instructions | string | 否 | 系统指令（类似 Chat 的 system） |
| reasoning | object | 否 | 推理控制，`{ effort: "high"|"medium"|"low"|"minimal", summary: "detailed"|"auto"|"concise" }` 解锁高阶思维链 |
| stream | boolean | 否 | 是否流式输出 |
| tools | array | 否 | 工具定义数组 |
| tool_choice | string/object | 否 | 工具选择策略 |
| text | object | 否 | 文本输出控制，如 `{ verbosity: "high" }` |
| truncation | string | 否 | 长上下文截断策略，`auto` |
| max_output_tokens | integer | 否 | 最大输出 Token（对应 Chat 的 `max_tokens`） |
| store | boolean | 否 | 是否存储响应 |
| include | array | 否 | 额外包含的输出项 |

## 请求示例（高阶思维链）

```bash
curl -X POST https://example.com/v1/responses \
  -H "Authorization: Bearer fwp-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5",
    "input": "请逐步思考并解决这个数学难题",
    "reasoning": { "effort": "high", "summary": "detailed" },
    "stream": false
  }'
```

## 流式响应

```bash
curl -X POST https://example.com/v1/responses \
  -H "Authorization: Bearer fwp-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5",
    "input": "Hello!",
    "reasoning": { "effort": "high" },
    "stream": true
  }'
```

流式事件包含 `response.output_text.delta` 等增量，网关对流式 `usage`（`input_tokens`/`output_tokens`）与 `reasoning` 增量做兼容解析，用于用量统计与空完成检测。

## 请求模板

`v1/responses` 使用独立的请求模板类型：管理后台创建模板时选择 **Responses API** 类型，可注入 `instructions`、`reasoning`、`max_output_tokens`、`tools`、`truncation` 等字段（见「请求模板」指南白名单）。`Chat` 模板不会影响 `v1/responses` 请求，`Responses` 模板也不会影响 `v1/chat/completions`，两者分池管理。

旧模板未设置类型时按 `Chat` 处理，确保存量行为不变。

## 下一步

