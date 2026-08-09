# API Key 管理

## 创建 API Key

在管理后台的「API Key 管理」页面，点击「添加 Key」按钮。

## 配置项

| 字段 | 说明 |
|------|------|
| 名称 | 自定义标识名称 |
| Token 额度 | 总 Token 使用上限 |
| 调用次数限制 | 总调用次数上限 |
| RPM 限制 | 每分钟请求数限制 |
| TPM 限制 | 每分钟 Token 数限制 |
| 重置周期 | monthly / daily / never |
| 过期时间 | 可选，到期自动禁用 |

## 自动重置

根据 `resetPeriod` 设置自动重置用量：

- `monthly` — 每月1日重置
- `daily` — 每天凌晨重置
- `never` — 永不重置

## 下一步

