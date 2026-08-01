# Troubleshooting

Common troubleshooting paths for self-hosted deployments ([Node.js Standalone](/en/deployment/standalone) / [Docker](/en/deployment/docker)) and serverless platforms ([Vercel](/en/deployment/vercel) / [EdgeOne](/en/deployment/edgeone)). Platform-specific issues are covered on each deployment page.

## Database Connection Failures

Error `P1001: Can't reach database server`:

1. Confirm the database service is running and reachable remotely
2. Check host, port, username and password in `DATABASE_URL`
3. Check that the firewall allows the database port (for MySQL also check `bind-address`)

## Service Returns 500

- Self-hosted: check the terminal output of `npx next start`, or use `docker logs <container>` for real-time logs
- Serverless: check function logs in the platform console (Vercel Function Logs, EdgeOne runtime logs)
- Verify `JWT_SECRET` is set and at least 32 chars — login endpoints return 500 when it is missing

## Cron Endpoints Return 401

Once `CRON_SECRET` is configured, requests must include the `Authorization: Bearer <CRON_SECRET>` header.

## Rate Limits Reset After Cold Start

Expected behavior: rate-limit counters reset after a serverless cold start — best-effort only, does not affect functionality.

## Port Already in Use

```bash
lsof -i :3000
PORT=3001 npx next start
```

## Low Memory

On environments with less than 1 GB of memory, append pool parameters to `DATABASE_URL`:

```
?connection_limit=5&pool_timeout=10
```

## Related Docs

- [Environment Variables](/en/deployment/env)
- [Nginx Configuration](/en/deployment/nginx)
