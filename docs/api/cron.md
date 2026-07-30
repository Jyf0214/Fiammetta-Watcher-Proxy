# Cron 任务

FWP 提供 3 个定时任务端点，用于系统维护。这些端点通过外部服务（如 Cloudflare Cron Triggers、Vercel Cron、GitHub Actions 或任何 HTTP 调度器）定时调用。

## 端点列表

| 端点 | 功能 | 建议频率 | 说明 |
|------|------|----------|------|
| `GET/POST /api/cron/model-fetch` | 模型发现 | 每 10 分钟 | 自动发现各平台支持的模型列表 |
| `GET/POST /api/cron/key-reset` | Key 重置 | 每天凌晨 | 重置 Key 的月度/日度用量计数器 |
| `GET/POST /api/cron/log-archive` | 日志归档 | 每天凌晨 | 将 30 天前的详细日志聚合为统计数据 |

## 认证

如果设置了 `CRON_SECRET` 环境变量，所有 cron 请求必须携带认证头：

```
Authorization: Bearer <CRON_SECRET>
```

如果未设置 `CRON_SECRET`，端点无需认证。

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
  "error": "错误信息"
}
```

**未知任务**：

```json
{
  "error": "Not Found",
  "message": "未知任务: xxx",
  "available": ["model-fetch", "key-reset", "log-archive"]
}
```

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
```

### Cloudflare Cron Triggers

在 `worker/wrangler.toml` 中配置：

```toml
[triggers]
crons = ["*/10 * * * *", "0 0 * * *", "0 1 * * *"]
```

### Vercel Cron

在项目根目录创建 `vercel.json`：

```json
{
  "crons": [
    { "path": "/api/cron/model-fetch", "schedule": "*/10 * * * *" },
    { "path": "/api/cron/key-reset", "schedule": "0 0 * * *" },
    { "path": "/api/cron/log-archive", "schedule": "0 1 * * *" }
  ]
}
```

### GitHub Actions

```yaml
name: Cron Tasks
on:
  schedule:
    - cron: '*/10 * * * *'
  workflow_dispatch:

jobs:
  cron:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger all cron tasks
        run: |
          for task in model-fetch key-reset log-archive; do
            curl -sf "https://your-domain/api/cron/$task" \
              -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}"
          done
```

### 外部 Cron 服务

使用 [Cron-job.org](https://cron-job.org)、[UptimeRobot](https://uptimerobot.com) 等服务：

1. 创建定时任务
2. URL 设置为 `https://your-domain/api/cron/model-fetch`
3. 如果启用了认证，在 Header 中添加 `Authorization: Bearer your-CRON_SECRET`
4. 设置执行频率（模型发现建议每 10 分钟，其余每天一次）

## 任务详细说明

### 模型发现（model-fetch）

- 遍历所有已配置的平台，调用其 `/v1/models` 接口获取支持的模型列表
- 将发现的模型写入 `platform_models` 表
- 支持平台类型：OpenAI、Azure、自定义 OpenAI 兼容接口
- 失败的平台不会影响其他平台的模型发现

### Key 重置（key-reset）

- 根据每个 Key 的 `resetPeriod` 设置重置用量
- `monthly`：每月 1 日凌晨重置
- `daily`：每天凌晨重置
- `never`：永不重置

### 日志归档（log-archive）

- 将 30 天前的详细请求日志（`request_logs` 表）聚合为每日统计数据（`daily_stats` 表）
- 聚合维度：日期 + API Key + 平台 + 模型
- 归档后删除原始详细日志，节省存储空间
