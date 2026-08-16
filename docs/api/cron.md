# Cron 任务

FWP 提供定时任务端点，用于系统维护。触发机制因部署方式而异：

- **Cloudflare 部署**：定时任务由 Worker 内置 `scheduled` 事件自动执行（模型发现、Key 用量重置、日志归档），**无需**通过 HTTP 调用本页端点
- **其他部署**（Vercel / EdgeOne / Node.js / Docker）：由外部调度服务（Vercel Cron、Cron-job.org、UptimeRobot 或任何 HTTP 调度器）定时调用本页端点

## 端点列表

| 端点 | 功能 | 建议频率 | 说明 |
|------|------|----------|------|
| `GET/POST /api/cron/model-fetch` | 模型发现 | 每 6 小时 | 自动发现各平台支持的模型列表 |
| `GET/POST /api/cron/key-reset` | Key 用量重置 | 每小时 | 按周期重置 Key 的月度/日度用量计数器（仅在周期开始时实际清零） |
| `GET/POST /api/cron/log-archive` | 日志归档 | 每天 3:00 | 将 30 天前的详细日志聚合为统计数据 |
| `GET/POST /api/cron/proxy-health` | 出站代理健康检查 | 按需 | 检查出站代理连通性（仅 Docker 部署配置了出站代理时生效） |

## 认证

如果设置了 `CRON_SECRET` 环境变量，所有 cron 请求必须携带认证头：

```
Authorization: Bearer <CRON_SECRET>
```

**必须配置 `CRON_SECRET`**：如果未设置，端点直接返回 403 禁用（防止无鉴权触发定时任务）。配置后务必让调度器携带上述认证头，否则调度请求会返回 401。

## 响应格式

**成功**：

```json
{
  "success": true,
  "task": "model-fetch",
  "elapsed": 1234
}
```

**失败**：

```json
{
  "success": false,
  "task": "model-fetch",
  "elapsed": 500,
  "error": "任务执行失败"
}
```

**未知任务**：

```json
{
  "error": "Not Found"
}
```

（未知任务与失败响应不回显内部错误细节或可用任务列表，防止信息泄露。）

## 调用示例

### cURL

```bash
# 模型发现
curl -X GET https://your-domain/api/cron/model-fetch \
  -H "Authorization: Bearer your-CRON_SECRET"

# Key 重置
curl -X GET https://your-domain/api/cron/key-reset \
  -H "Authorization: Bearer your-CRON_SECRET"

# 日志归档
curl -X GET https://your-domain/api/cron/log-archive \
  -H "Authorization: Bearer your-CRON_SECRET"

# 出站代理健康检查（仅 Docker 部署配置了出站代理时使用）
curl -X GET https://your-domain/api/cron/proxy-health \
  -H "Authorization: Bearer your-CRON_SECRET"
```

### Cloudflare Cron Triggers

在 `worker/wrangler.toml` 中配置：

```toml
[triggers]
crons = ["0 */6 * * *", "0 */1 * * *", "0 3 * * *"]
```

（Cloudflare 部署时 `worker/wrangler.toml` 已内置以上配置，无需手动修改。）

### Vercel Cron

在项目根目录创建 `vercel.json`：

```json
{
  "crons": [
    { "path": "/api/cron/model-fetch", "schedule": "0 */6 * * *" },
    { "path": "/api/cron/key-reset",   "schedule": "0 */1 * * *" },
    { "path": "/api/cron/log-archive", "schedule": "0 3 * * *" }
  ]
}
```

### 外部 Cron 服务

使用 [Cron-job.org](https://cron-job.org)、[UptimeRobot](https://uptimerobot.com) 等服务：

1. 创建定时任务
2. URL 设置为 `https://your-domain/api/cron/model-fetch`
3. 如果启用了认证，在 Header 中添加 `Authorization: Bearer your-CRON_SECRET`
4. 设置执行频率（模型发现每 6 小时、Key 用量重置每小时、日志归档每天 3:00）

## 任务详细说明

### 模型发现（model-fetch）

- 遍历所有已配置的平台，调用其 `/v1/models` 接口获取支持的模型列表
- 将发现的模型写入 `platform_models` 表
- 支持平台类型：OpenAI、Azure、自定义 OpenAI 兼容接口（Anthropic 类型平台暂不支持自动发现，可手动添加模型）
- 失败的平台不会影响其他平台的模型发现

### Key 重置（key-reset）

- 根据每个 Key 的 `resetPeriod` 设置重置用量
- `monthly`：每月 1 日凌晨重置
- `daily`：每天凌晨重置
- `never`：永不重置

### 日志归档（log-archive）

- 将 30 天前的详细请求日志（`request_logs` 表）聚合为每日统计数据（`daily_stats` 表）
- 聚合维度：日期 + API Key + 模型
- 归档后删除原始详细日志，节省存储空间
