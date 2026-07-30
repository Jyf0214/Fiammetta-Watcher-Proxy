# 什么是 FWP

**Fiammetta Watcher Proxy**（简称 FWP）是一个开源的多平台 AI API 代理网关。

## 为什么需要 FWP？

当你使用多个 AI 平台（OpenAI、Anthropic、Google 等）时，会遇到以下问题：

- 每个平台有不同的 API 格式和认证方式
- 需要分别管理多个 API Key
- 无法统一监控各平台的用量和成本
- 某个平台故障时需要手动切换

**FWP 解决了这些问题**：它提供一个统一的入口，将请求智能路由到不同的后端平台。

## 核心概念

```
客户端 → FWP → OpenAI / Anthropic / Google / ...
```

- **平台（Platform）**：后端 AI 服务提供商
- **API Key**：客户端用来认证的密钥
- **模型映射（Model Map）**：将一个模型名映射到另一个模型名
- **代理池（Proxy Pool）**：用于访问平台的 HTTP 代理集合
- **套餐（Plan）**：定义 Key 的配额和限制

## 下一步

