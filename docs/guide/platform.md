# 平台配置

## 添加平台

在管理后台的「平台管理」页面，点击「添加平台」按钮。

## 配置项

| 字段 | 说明 |
|------|------|
| 平台名称 | 自定义名称，用于标识 |
| Base URL | 平台 API 地址 |
| API Key | 平台的认证密钥 |
| 平台类型 | OpenAI 兼容 / Azure / 自定义 / Anthropic |
| 优先级 | 数值越大优先级越高 |
| 权重 | 路由分配比例 |
| RPM 限制 | 每分钟请求数限制 |
| TPM 限制 | 每分钟 Token 数限制 |

## 平台类型

平台类型决定上游协议：

- **OpenAI 兼容**：大多数厂商的 OpenAI 兼容端点（OpenAI、Google、DeepSeek 等）
- **Azure**：Azure OpenAI 服务
- **自定义**：自定义 OpenAI 兼容网关
- **Anthropic**：Anthropic 原生协议，用于官方 Claude API、GitHub Copilot 等网关

## 命名密钥

支持为每个平台配置多个命名密钥：

```json
[
  {"name": "密钥1", "key": "sk-xxx"},
  {"name": "密钥2", "key": "sk-yyy"}
]
```

## 启用/禁用

平台支持随时启用或禁用，禁用后不会接收请求。

## 下一步

