/**
 * Fiammetta Watcher Proxy — Cloudflare Worker 入口
 *
 * 职责：
 * 1. 代理 OpenAI 兼容 API 请求（v1/*）
 * 2. 定时任务（Cron Triggers）：API Key 用量重置、模型发现、日志归档
 *
 * Admin 管理后台的 CRUD 操作由 Cloudflare Pages Functions 处理。
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { ScheduledEvent, ExecutionContext } from "@cloudflare/workers-types";
import type { Env } from "./types";
import { v1Routes } from "./routes/v1";
import { handleCron } from "./cron";

const app = new Hono<{ Bindings: Env }>();

// ==================== 全局中间件 ====================

// 请求日志
app.use("*", logger());

// CORS — 允许前端域名访问 v1 API
app.use(
  "/api/v1/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  })
);

// 安全响应头
app.use("*", async (c, next) => {
  await next();
  c.header("X-Frame-Options", "DENY");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.header("X-XSS-Protection", "0");
  c.header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
  c.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
});

// ==================== API 路由挂载 ====================

app.route("/api/v1", v1Routes);

// 根路径 — 返回 Worker 信息
app.get("/", (c) => {
  return c.json({
    name: "Fiammetta Watcher Proxy",
    version: "2.0.0",
    runtime: "cloudflare-workers",
    role: "proxy",
  });
});

// 404 处理
app.notFound((c) => {
  return c.json(
    { error: { message: "接口不存在", type: "invalid_request_error" } },
    { status: 404 }
  );
});

// 全局错误处理
app.onError((err, c) => {
  console.error("[worker] 未捕获异常:", err.message);
  return c.json(
    { error: { message: "服务器内部错误", type: "server_error" } },
    { status: 500 }
  );
});

// ==================== 导出 ====================

export default {
  // HTTP 请求处理
  fetch: app.fetch,

  // Cron 触发器处理（定时任务：API Key 重置、模型发现、日志归档）
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleCron(event, env));
  },
};
