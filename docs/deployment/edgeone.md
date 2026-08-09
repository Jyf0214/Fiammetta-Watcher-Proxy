# EdgeOne 部署

EdgeOne（腾讯云 EdgeOne Makers）：代理与定时任务由服务端函数处理，数据库用远程 TiDB / MariaDB / PostgreSQL。

::: warning 新平台，首次部署请人工验证
EdgeOne Makers 较新，本文基于当前部署流程编写。首次部署后请人工验证代理、管理后台与数据库连接是否正常。
:::

## 前置条件

1. [EdgeOne Makers](https://console.cloud.tencent.com/edgeone) 账号与项目（记下项目名）
2. EdgeOne API Token（Makers 控制台生成）
3. 远程数据库：TiDB Cloud、MariaDB 或 PostgreSQL（**必须**，EdgeOne 没有内置数据库）
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

运行后自动构建并上传，无需其他操作。构建期间 CLI 自动执行依赖安装与 `prisma generate`；非 D1 数据库（tidb/mariadb/pg）时自动执行 `prisma db push` 同步表结构（CI 环境自动触发）。

## 3. 配置运行时环境变量

Makers 控制台 → 项目 → 运行时环境变量（**部署前必须配置好**，构建期与运行时共用）。完整变量清单与说明见 [环境变量](/deployment/env)。

## 4. 定时任务

EdgeOne 无内置定时任务，用外部调度服务定时请求 `/api/cron/*` 端点即可（端点与建议频率见 [Cron 任务说明](/api/cron)）。可用服务：Cron-job.org、UptimeRobot。

## 5. 验证

| 检查项 | 方法 |
|--------|------|
| 健康检查 | `curl -H "Authorization: Bearer <系统API Key>" https://你的域名/api/health` → `{"status":"ok",...}`（需管理员认证） |
| 代理可用 | `curl https://你的域名/v1/models`（无需 API Key，返回 200 模型列表即正常；只有 POST 代理接口需要认证） |
| 管理后台 | 浏览器访问 `/admin`，用 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登录 |
| 数据库 | 登录后台 → 模型/日志页面确认数据读写正常 |

> 上表中的 `<系统API Key>` 指**系统 API Key**（`sk-sys-*` 格式）：部署成功后登录管理后台 `/admin` → 左侧「系统密钥」页面生成。它用于系统级接口的 Bearer 认证，与用户 API Key 相互独立。

## 常见问题

### 流式响应/代理超时

EdgeOne 首次部署性能未经充分验证，如遇流式中断或超时，检查平台文档确认函数超时与流式支持；必要时改用 Vercel 或 Cloudflare。

> 更多通用排查见 [常见问题排查](/deployment/troubleshooting)。

## 相关文档

- [架构说明](/deployment/architecture)
- [环境变量](/deployment/env)
- [Vercel 部署](/deployment/vercel) — 同一套运行方式
