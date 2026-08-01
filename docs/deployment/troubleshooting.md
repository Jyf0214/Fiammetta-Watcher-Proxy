# 常见问题排查

适用于自托管部署（[Node.js 直接部署](/deployment/standalone) / [Docker](/deployment/docker)）与 Serverless 平台（[Vercel](/deployment/vercel) / [EdgeOne](/deployment/edgeone)）的通用排查路径。各平台特有问题的处理见对应部署页。

## 数据库连接失败

错误 `P1001: Can't reach database server`：

1. 确认数据库服务已启动且可远程连接
2. 检查 `DATABASE_URL` 的主机、端口、用户名、密码
3. 检查防火墙是否放行数据库端口（MySQL 还需检查 `bind-address`）

## 服务返回 500

- 自托管：查看启动终端输出（`npx next start` 前台运行）或使用 `docker logs <容器名>` 查看实时日志
- Serverless：在平台控制台查看函数日志（Vercel 的 Function Logs、EdgeOne 的运行日志）
- 检查 `JWT_SECRET` 是否已设置且不少于 32 字符——缺失时登录接口会直接返回 500

## 定时任务端点返回 401

配置了 `CRON_SECRET` 后，请求必须带 `Authorization: Bearer <CRON_SECRET>` 头。

## 速率限制在冷启动后重置

预期行为：Serverless 冷启动后限流计数会清零，属尽力而为，不影响功能。

## 端口被占用

```bash
lsof -i :3000
PORT=3001 npx next start
```

## 内存不足

内存小于 1GB 的环境在 `DATABASE_URL` 末尾追加连接池参数：

```
?connection_limit=5&pool_timeout=10
```

## 相关文档

- [环境变量](/deployment/env)
- [Nginx 配置](/deployment/nginx)
