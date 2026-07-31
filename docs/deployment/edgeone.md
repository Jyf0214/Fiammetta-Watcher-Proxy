# EdgeOne 部署

EdgeOne（腾讯云 EdgeOne Makers）：代理与定时任务由服务端函数处理，数据库用远程 TiDB / PostgreSQL。

::: warning 新平台，首次部署请人工验证
EdgeOne Makers 较新，本文基于当前部署流程编写。首次部署后请人工验证代理、管理后台与数据库连接是否正常。
:::

## 前置条件

1. [EdgeOne Makers](https://console.cloud.tencent.com/edgeone) 账号与项目（记下项目名）
2. EdgeOne API Token（Makers 控制台生成）
3. 远程数据库：TiDB Cloud 或 PostgreSQL（**必须**，EdgeOne 没有内置数据库）
4. GitHub 账号

## 1. 配置 GitHub Secrets

仓库 Settings → Secrets and variables → Actions：

| Secret | 说明 |
|--------|------|
| `EO_PROJECT_NAME` | EdgeOne Makers 项目名 |
| `EO_API_TOKEN` | EdgeOne API Token |

> `DB_TYPE` 与 `DATABASE_URL` **不需要**配置为 GitHub Secrets——构建期由 EdgeOne CLI 从 Makers 项目环境变量拉取（写入 `.env`），运行时也使用同一组变量。

## 2. 触发部署

Fork 项目到你的 GitHub 账号后，在 Actions 页面手动运行工作流（首次需按提示启用）：

Actions → Deploy 工作流 → Run workflow → **分支选择 `canary`**（Fork 后的默认分支不是 `canary`，务必手动选择）→ 平台选择 `edgeone` 或 `both` → 点击 Run workflow。

运行后自动构建并上传，无需其他操作。构建期间 CLI 自动执行依赖安装与 `prisma generate`；非 D1 数据库（tidb/pg）时自动执行 `prisma db push` 同步表结构（CI 环境自动触发）。

## 3. 配置运行时环境变量

Makers 控制台 → 项目 → 运行时环境变量（**部署前必须配置好**，构建期与运行时共用）：

```env
DB_TYPE=tidb                        # 或 pg，不能是 d1
DATABASE_URL=mysql://用户名:密码@host:4000/dbname?sslaccept=accept_invalid_certs
ADMIN_USERNAME=admin
ADMIN_PASSWORD=你的管理员密码
JWT_SECRET=至少32字符的随机密钥      # 必填，未设置则无法登录
CRON_SECRET=随机密钥                # 可选
```

## 4. 定时任务

EdgeOne 无内置定时任务，用外部调度服务定时调用：

```bash
curl -X GET https://你的域名/api/cron/model-fetch \
  -H "Authorization: Bearer 你的CRON_SECRET"
```

| 端点 | 功能 | 建议频率 |
|------|------|----------|
| `/api/cron/model-fetch` | 模型发现 | 每 6 小时 |
| `/api/cron/key-reset` | Key 用量重置 | 每小时 |
| `/api/cron/log-archive` | 日志归档 | 每天 3:00 |

可用服务：Cron-job.org、UptimeRobot、GitHub Actions `schedule` 触发器（示例见 [Vercel 部署](/deployment/vercel)）。

## 5. 验证

| 检查项 | 方法 |
|--------|------|
| 健康检查 | `https://你的域名/api/health` → `{"status":"ok",...}` |
| 代理可用 | `curl https://你的域名/v1/models`（无 API Key 返回 401 即正常） |
| 管理后台 | 浏览器访问 `/admin`，用 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登录 |
| 数据库 | 登录后台 → 模型/日志页面确认数据读写正常 |

## 常见问题

### 流式响应/代理超时

EdgeOne 首次部署性能未经充分验证，如遇流式中断或超时，检查平台文档确认函数超时与流式支持；必要时改用 Vercel 或 Cloudflare。

## 相关文档

- [架构说明](/deployment/architecture)
- [环境变量](/deployment/env)
- [Vercel 部署](/deployment/vercel) — 同一套运行方式
