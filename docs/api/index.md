# API 参考

FWP 提供 OpenAI 兼容的代理 API 和管理后台 API。

## 代理 API（V1）

### 基础信息

- **Base URL**: `https://your-domain/v1`
- **认证方式**: Bearer Token（API Key）

### 认证

所有请求需要在 `Authorization` 头中携带 API Key：

```
Authorization: Bearer fwp-your-api-key
```

### 端点列表

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/chat/completions` | POST | 聊天补全（支持流式） |
| `/v1/completions` | POST | 文本补全 |
| `/v1/embeddings` | POST | 文本嵌入 |
| `/v1/responses` | POST | OpenAI Responses API |
| `/v1/models` | GET | 获取平台支持的模型列表 |
| `/v1/models/{model}` | GET | 获取单个模型信息 |
| `/v1/images/generations` | POST | 图像生成 |
| `/v1/images/edits` | POST | 图像编辑（multipart/form-data） |
| `/v1/images/variations` | POST | 图像变体（multipart/form-data） |
| `/v1/audio/speech` | POST | 文字转语音（TTS） |
| `/v1/audio/transcriptions` | POST | 语音转文字（Whisper） |
| `/v1/audio/translations` | POST | 语音翻译 |

### 请求示例

**聊天补全（流式）**:

```bash
curl -X POST https://your-domain/v1/chat/completions \
  -H "Authorization: Bearer fwp-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

### 响应格式

所有响应遵循 OpenAI 标准格式：

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "gpt-4o",
  "choices": [
    {
      "index": 0,
      "message": {"role": "assistant", "content": "Hello!"},
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

流式响应使用 Server-Sent Events (SSE)。

### 错误响应

| 状态码 | 说明 |
|--------|------|
| 400 | 请求参数错误 |
| 401 | API Key 无效、已过期或已禁用 |
| 403 | API Key 已禁用 |
| 429 | 速率限制（RPM/TPM 超限） |
| 500 | 服务器内部错误 |
| 502 | 上游平台错误 |
| 503 | 所有平台不可用（熔断或离线） |

## 管理后台 API

管理后台 API 需要管理员 JWT 认证（通过 Cookie 中的 `admin_token`）。

### 认证 API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/admin/auth` | POST | 管理员登录 |
| `/api/admin/auth/change-password` | POST | 修改密码 |
| `/api/admin/auth/reset-password` | POST | 重置密码 |

### 平台管理 API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/admin/platforms` | GET | 获取所有平台列表 |
| `/api/admin/platforms` | POST | 创建新平台 |
| `/api/admin/platforms/{id}` | PUT | 更新平台配置 |
| `/api/admin/platforms/{id}` | DELETE | 删除平台 |
| `/api/admin/platforms/{id}/models` | GET | 获取平台发现的模型列表 |
| `/api/admin/platforms/{id}/models` | POST | 手动添加平台模型 |
| `/api/admin/platforms/{id}/models` | PUT | 更新平台模型 |
| `/api/admin/platforms/{id}/models` | DELETE | 删除平台模型 |

### API Key 管理 API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/admin/keys` | GET | 获取所有 Key 列表 |
| `/api/admin/keys` | POST | 创建新 Key |
| `/api/admin/keys/{id}` | PUT | 更新 Key 配置 |
| `/api/admin/keys/{id}` | DELETE | 删除 Key |

### 模型映射 API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/admin/models` | GET | 获取所有模型映射 |
| `/api/admin/models` | POST | 创建模型映射 |
| `/api/admin/models/{id}` | DELETE | 删除模型映射 |

### 代理管理 API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/admin/proxies` | GET | 获取所有代理列表 |
| `/api/admin/proxies` | POST | 创建代理 |
| `/api/admin/proxies/{id}` | PUT | 更新代理配置 |
| `/api/admin/proxies/{id}` | DELETE | 删除代理 |
| `/api/admin/proxies/import` | POST | 批量导入代理 |

### 代理池 API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/admin/pools` | GET | 获取所有代理池 |
| `/api/admin/pools` | POST | 创建代理池 |
| `/api/admin/pools/{id}` | PUT | 更新代理池 |
| `/api/admin/pools/{id}` | DELETE | 删除代理池 |

### 监控统计 API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/admin/stats` | GET | 获取系统统计概览 |
| `/api/admin/usage` | GET | 获取用量数据 |
| `/api/admin/usage/trend` | GET | 获取用量趋势（支持 period 参数） |
| `/api/admin/usage/platform` | GET | 按平台维度获取用量 |
| `/api/admin/logs` | GET | 获取请求日志（支持分页） |
| `/api/admin/logs/archive` | POST | 手动触发日志归档 |
| `/api/admin/audit` | GET | 获取审计日志（支持分页） |

### 系统管理 API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/admin/config` | GET | 获取系统配置 |
| `/api/admin/config` | PUT | 更新系统配置 |
| `/api/admin/export` | GET | 导出数据（支持 type 参数） |
| `/api/admin/import` | POST | 导入数据 |
| `/api/admin/debug` | GET | 调试信息 |

### 公开 API（无需认证）

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/health` | GET | 健康检查 |
| `/api/config` | GET | 获取公开配置 |
| `/api/setup/status` | GET | 检查初始化状态 |
| `/api/setup/configure` | POST | 首次配置（设置数据库和管理员） |
