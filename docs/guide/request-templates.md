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
| 适用模型 | 模型 ID 通配符列表（如 `gpt-*`），支持按回车添加；默认 `*`（所有模型） |
| 请求体内容 | 要注入的 JSON 字段（见下方白名单），深度合并到上游请求体 |
| 启用 | 关闭后模板不生效 |

页面提供 4 个快速填充示例：启用深度思考、模型思考强度、强制 JSON 输出、温度控制。

## 可注入字段（白名单）

模板只允许写入以下字段，**白名单外的字段一律丢弃**：

`system`、`temperature`、`top_p`、`top_k`、`max_tokens`、`max_completion_tokens`、`frequency_penalty`、`presence_penalty`、`stop`、`stream`、`stream_options`、`n`、`logprobs`、`top_logprobs`、`response_format`、`seed`、`reasoning_effort`、`chat_template_kwargs`、`extra_body`

## 匹配与合并规则

- 按客户端请求的**模型 ID** 做通配符匹配（`*` 通配，不区分大小写），仅启用的模板生效
- 多个模板同时命中时**按存储顺序依次合并**，后应用的覆盖同名键；数组字段整体替换（不合并）
- 模板作用于每次上游尝试的请求体，保存后立即生效（30 秒缓存 + 变更检测）

## 与 Anthropic 平台的关系

模板在协议转换**之前**应用：先注入 OpenAI 格式请求体，再转换为 Anthropic 原生协议。转换时 `stream_options` / `n` / `response_format` 等 OpenAI 专属字段会被剥离，避免 Anthropic 严格后端报 422；`system` / `temperature` / `top_p` / `top_k` / `max_tokens` / `stop` 等字段正常生效。

## 下一步

- [平台配置](/guide/platform) — 配置上游 AI 服务提供商
- [API Key 管理](/guide/api-key) — 创建和管理 API Key
- [API 参考](/api/) — 请求模板管理端点