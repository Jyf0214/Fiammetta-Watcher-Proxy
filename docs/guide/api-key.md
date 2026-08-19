# API Key 管理

## 创建 API Key

在管理后台的「API Key 管理」页面，点击「添加 Key」按钮。

## 配置项

| 字段 | 说明 |
|------|------|
| 名称 | 自定义标识名称 |
| Token 额度 | 总 Token 使用上限（0 表示不设限制） |
| 调用次数限制 | 总调用次数上限（0 表示不设限制） |
| RPM 限制 | 每分钟请求数限制 |
| TPM 限制 | 每分钟 Token 数限制 |
| 重置周期 | monthly / daily / never（默认 monthly） |
| 过期时间 | 可选；到期后请求返回 401 被拒绝（当前管理界面未提供该输入项，可通过导入或 API 设置） |

## 自动重置

根据 `resetPeriod` 设置自动重置用量，由定时任务触发：

- `monthly` — 每月 1 日重置
- `daily` — 每天凌晨重置
- `never` — 永不重置

重置由定时任务执行：Cloudflare 部署由 Worker 内置 Cron 每小时检查，Docker 部署由容器内部定时器自动执行，其他部署需外部定时调用 [Cron 任务](/api/cron) 中的 `/api/cron/key-reset`（需 `CRON_SECRET` 认证）。若部署环境未配置任何定时调度，用量不会自动重置。

## 下一步

- [平台配置](/guide/platform) — 配置上游 AI 服务提供商
- [系统 API Key](/guide/system-key) — 管理后台 API 认证
- [API 参考](/api/) — 使用 API Key 调用各端点

