# Vercel 部署

## 前置条件

1. [Vercel 账号](https://vercel.com/signup)
2. 远程数据库：[TiDB Cloud](https://tidbcloud.com/)（免费）、MySQL、MariaDB 或 PostgreSQL
3. GitHub 仓库

## 1. 导入项目

Vercel Dashboard → Add New → Project → 从 GitHub 导入仓库。框架预设选 **Next.js**，构建命令保持默认即可。

## 2. 配置环境变量

Settings → Environment Variables 中配置（`DB_TYPE` 不能为 `d1`），完整变量清单与说明见 [环境变量](/deployment/env)。

## 3. 部署

推送代码即自动部署。注意：部署后还需配置定时任务（见下一节），免费方案下需外部服务定时调用。

## 4. 定时任务

3 个定时任务的业务逻辑与端点详见 [Cron 任务说明](/api/cron)。

### 方式 A：Vercel Cron（需 Pro 计划）

Hobby 计划每天最多触发 1 次定时任务，本项目所需的每 6 小时 / 每小时频率需要 Pro 计划。在项目根目录创建 `vercel.json`（仓库中没有，需自行创建）：

```json
{
  "crons": [
    { "path": "/api/cron/model-fetch", "schedule": "0 */6 * * *" },
    { "path": "/api/cron/key-reset",   "schedule": "0 */1 * * *" },
    { "path": "/api/cron/log-archive", "schedule": "0 3 * * *" }
  ]
}
```

设置 `CRON_SECRET` 后 Vercel 会自动带上认证头。

### 方式 B：外部调度（免费）

用外部服务定时请求 `/api/cron/*` 端点（端点与建议频率见 [Cron 任务说明](/api/cron)）。可用服务：Cron-job.org、UptimeRobot。

## 数据库选择

### TiDB Cloud（免费，推荐）

注册 → 创建 Serverless 集群 → 复制连接串：

```
mysql://用户名:密码@gateway01.xxxx.prod.aws.tidbcloud.com:4000/dbname?sslaccept=accept_invalid_certs
```

`DB_TYPE=tidb`。

### MariaDB / 纯 MySQL

任意可远程访问的 MariaDB 或 MySQL（云厂商 RDS / 自建）：

```
DB_TYPE=mariadb
DATABASE_URL=mariadb://用户:密码@主机:端口/数据库名
```

### PostgreSQL

任意可远程访问的 PostgreSQL（Neon / Supabase / Railway / 自建）：

```
DB_TYPE=pg
DATABASE_URL=postgresql://用户:密码@主机:端口/数据库名
```

> 内存小于 1GB 的环境可在连接串末尾追加 `?connection_limit=5&pool_timeout=10`。

## 常见问题

### 速率限制在冷启动后重置

预期行为：Serverless 冷启动后限流计数会清零，属尽力而为，不影响功能。

### 定时任务端点返回 401

配置了 `CRON_SECRET` 后，请求必须带 `Authorization: Bearer <CRON_SECRET>` 头。

### 数据库连接超时

- 确认数据库允许远程连接（TiDB Cloud 天然支持）
- 检查防火墙 / 白名单是否放行

> 更多通用排查见 [常见问题排查](/deployment/troubleshooting)。

## 相关文档

- [架构说明](/deployment/architecture)
- [环境变量](/deployment/env)
- [EdgeOne 部署](/deployment/edgeone) — 同一套运行方式
