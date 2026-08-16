# 系统 API Key

系统 API Key 是用于**管理后台 API 认证**（`Authorization: Bearer`）的凭证，供程序化调用管理 API 使用，**不可用于 V1 代理**。

## 创建系统 Key

在管理后台「系统」分组的「系统 API Key」页面点击「创建系统 Key」，只需填写名称。

- 密钥创建后**仅显示一次**，请立即复制保存
- 格式：`sk-sys-` + 48 位十六进制（共 55 字符）
- 系统 Key 永不过期

## 启用 / 禁用 / 删除

- **启用/禁用**：页面上的开关即时生效（禁用的 Key 认证立即被拒绝）
- **删除**：永久移除，不可恢复

## 系统 Key 能访问什么

| 区域 | 认证方式 |
|------|----------|
| 管理后台 API（`/api/admin/*` + `/api/health`） | 系统 Key（`Bearer`）或管理员 JWT |
| V1 代理（`/v1/*`） | **仅用户 API Key**，系统 Key 不可用 |
| Cron 端点（`/api/cron/*`） | `CRON_SECRET` Bearer，系统 Key 不可用 |

典型用途：健康检查、自动化运维脚本、CI/CD、跨系统集成（导出/导入、统计、日志归档）。

## 与用户 API Key 的区别

| 维度 | 系统 API Key | 用户 API Key |
|------|--------------|--------------|
| 用途 | 管理后台 API 认证 | V1 代理转发 |
| 认证头 | 仅 `Authorization: Bearer` | `authorization` 或 `x-api-key` |
| 前缀 | `sk-sys-` | 无（自定义） |
| 配额 | 无（不限 Token/次数） | Token/次数/RPM/TPM 限制 |
| 过期 | 永不过期 | 可选 `expiresAt` |
| 启停 | `enabled` 布尔 | `status` 字段 |

## 下一步

- [API Key 管理](/guide/api-key) — 创建 V1 代理用的用户 API Key
- [API 参考](/api/) — 管理后台 API 端点
- [部署指南](/deployment/) — 使用系统 Key 做健康检查的示例
