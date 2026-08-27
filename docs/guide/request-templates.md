# 请求模板

请求模板用于**自定义上游请求格式**：对匹配的请求自动注入额外字段，无需修改客户端。

## 适用场景

- 为某个模型统一附加参数（如 `reasoning_effort`、`response_format`）
- 强制 JSON 输出、控制温度
- 为不支持某字段的平台剥离参数（模板在转换前应用）

## 创建模板

在管理后台「请求模板」页面点击「新建模板」，填写：

| 字段 | 说明 |
|------|------|
| 模板名称 | 必填，自定义标识 |
| 描述 | 可选，说明模板用途 |
| 模板类型 | 必选：`Chat Completions`（普通 `v1/chat/completions` 等）或 `Responses API`（新一代 `v1/responses`，解锁高阶思维链 `reasoning`）；旧模板未设置类型时按 `Chat` 处理 |
| 适用模型 | 模型 ID 通配符列表（如 `gpt-*`），支持按回车添加；默认 `*`（所有模型） |
| 请求体内容 | 必填，要注入的 JSON 字段（见下方白名单），深度合并到上游请求体 |
| 启用 | 默认开启；关闭后模板不生效 |

页面提供 8 个快速填充示例：`Chat` 类（启用深度思考、模型思考强度、强制 JSON 输出、温度控制）与 `Responses` 类（高阶思维链、系统指令+推理、工具调用、长上下文截断）各 4 个。

## 可注入字段（白名单）

模板按类型使用不同白名单，**白名单外的字段一律丢弃**：

**Chat Completions 白名单**（`type=chat`，普通 `v1/chat` 代理）：

`system`、`temperature`、`top_p`、`top_k`、`max_tokens`、`max_completion_tokens`、`frequency_penalty`、`presence_penalty`、`stop`、`stream`、`stream_options`、`n`、`logprobs`、`top_logprobs`、`response_format`、`seed`、`reasoning_effort`、`chat_template_kwargs`、`extra_body`、`thinking`、`reasoning_split`

**Responses API 白名单**（`type=responses`，`v1/responses` 代理，解锁高阶思维链）：

`instructions`、`reasoning`（`{ effort: "high"|"medium"|"low", summary: "detailed"|"auto" }` 解锁思维链）、`max_output_tokens`、`truncation`、`text`、`tools`、`tool_choice`、`parallel_tool_calls`、`store`、`include`、`metadata`、`service_tier`、`prompt_cache_key`、`safety_identifier`、`background`、`previous_response_id`、`temperature`、`top_p`、`top_logprobs`、`stream`、`seed`、`frequency_penalty`、`presence_penalty`、`stop`、`n`、`logprobs`、`response_format`、`reasoning_effort`、`chat_template_kwargs`、`extra_body`

## 匹配与合并规则

- 按 **模板类型 + 模型 ID** 双重过滤：`Chat` 模板仅在 `v1/chat/completions` 等普通代理链路生效，`Responses` 模板仅在 `v1/responses` 链路生效；下游按 `v1/responses` 请求时，上游也按 `v1/responses` 转发，模板类型与协议一一对应，互不干扰。旧模板未设置类型时按 `Chat` 处理，确保存量行为不变
- 再按客户端请求的**模型 ID** 做通配符匹配（`*` 通配，不区分大小写），仅启用的模板生效
- 多个模板同时命中时**按存储顺序依次合并**，后应用的覆盖同名键；数组字段整体替换（不合并）
- 模板作用于每次上游尝试的请求体，保存后立即生效（30 秒缓存 + 变更检测）
- `Chat` 与 `Responses` 模板分池存储，互不覆盖：同一模型可同时配置两类模板，分别在对应协议下生效

## 与 Anthropic 平台的关系

模板在协议转换**之前**应用：先注入 OpenAI 格式请求体，再转换为 Anthropic 原生协议。转换时 `stream_options` / `n` / `response_format` 等 OpenAI 专属字段会被剥离，避免 Anthropic 严格后端报 422；`system` / `temperature` / `top_p` / `top_k` / `max_tokens` / `stop` 等字段正常生效。

厂商私有顶层字段（如 `thinking` / `reasoning_split`）同样会被转换层剥离，**仅在 OpenAI 协议上游生效**；若平台 `protocol=anthropic` 而模板注入这些字段，请求时会被静默丢弃且无日志提示，请将模板绑定到对应的 OpenAI 兼容平台。

## 下一步

- [平台配置](/guide/platform) — 配置上游 AI 服务提供商
- [API Key 管理](/guide/api-key) — 创建和管理 API Key
- [API 参考](/api/) — 请求模板管理端点
