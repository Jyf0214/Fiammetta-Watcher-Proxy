/**
 * Playground 调试台 API
 *
 * GET  /api/admin/playground — 可用模型列表（跨平台聚合）+ API Key 清单（仅 id/name）
 * POST /api/admin/playground — 以所选 API Key 的身份向本实例 /v1/chat/completions
 *                              发起对话（服务端注入密钥，密钥不落浏览器）
 *
 * 转发方式：服务端回环 fetch 自身 origin 的 v1 入口——零重构复用完整代理链路
 * （路由/重试/熔断/日志/成本记账与真实请求完全一致）。⚠️ 该模式依赖运行时
 * 能自调用本机 HTTP 端口（EdgeOne 函数环境需实测）；若部署平台禁止回环，
 * 此端点会返回明确的 502 提示而非静默失败。
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest, getAuditAdminId } from "@/lib/admin-auth";
import { getClientIp } from "./auth";
import { checkCsrfOrigin } from "@/lib/admin-security";
import { checkAdminRateLimit } from "@/lib/admin-rate-limit";
import { refreshCache, getPlatformModelCache } from "../../../worker/src/router";
import type { WorkerEnv } from "../../../worker/src/config";

/**
 * 从请求头推导本实例对外 origin。
 *
 * 安全约束：只信任 Host 头决定目标主机，忽略 x-forwarded-host——
 * 该头可被客户端伪造；若采纳，持管理会话者可让服务端把携带所选 Key
 * 明文的 Authorization 头发往任意地址（Key 外带 + 内网探测）。
 * x-forwarded-proto 仅影响 scheme 不影响目标主机，保留以兼容强制
 * HTTPS 的反代（否则回环 http 会被 301 重定向并丢失 POST 体）。
 */
function resolveOrigin(req: NextApiRequest): string {
  const host = req.headers.host || "localhost";
  const proto = (req.headers["x-forwarded-proto"] as string) === "https" ? "https" : "http";
  return `${proto}://${host}`;
}

/** dummyDb 占位（与 pages/api/v1 相同语义：createDb 忽略绑定走环境变量） */
const DUMMY_DB = {} as D1Database;

async function createPagesEnv(): Promise<WorkerEnv> {
  return {
    DB_TYPE: process.env.DB_TYPE,
    DATABASE_URL: process.env.DATABASE_URL,
    TIDB_URL: process.env.TIDB_URL,
    MYSQL_URL: process.env.MYSQL_URL,
    PG_URL: process.env.PG_URL,
    MARIADB_URL: process.env.MARIADB_URL,
    DEPLOY_PLATFORM: process.env.DEPLOY_PLATFORM,
  };
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    res.status(401).json({ success: false, error: "未授权" });
    return;
  }

  try {
    const db = await createDb();

    if (req.method === "GET") {
      if (!(await checkAdminRateLimit(admin.adminId, res))) return;

      // 模型聚合（与 /v1/models 同源缓存）+ Key 名录（不含明文）
      const env = await createPagesEnv();
      await refreshCache(DUMMY_DB, env);
      const pm = getPlatformModelCache();
      const seen = new Set<string>();
      const models: string[] = [];
      for (const ms of pm.values()) {
        for (const mid of ms) {
          if (!seen.has(mid)) {
            seen.add(mid);
            models.push(mid);
          }
        }
      }
      models.sort((a, b) => a.localeCompare(b));

      const keys = await db.apiKeys.findMany({
        where: { status: "active" },
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true },
      });

      res.status(200).json({ success: true, data: { models, keys } });
      return;
    }

    if (req.method === "POST") {
      if (!checkCsrfOrigin(req, res)) return;
      if (!(await checkAdminRateLimit(admin.adminId, res))) return;

      const body = req.body as {
        model?: string;
        messages?: Array<{ role: string; content: string }>;
        apiKeyId?: string;
        temperature?: number;
        maxTokens?: number;
        stream?: boolean;
      };

      const model = typeof body.model === "string" ? body.model.trim() : "";
      if (!model) {
        res.status(400).json({ success: false, error: "请选择模型" });
        return;
      }
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        res.status(400).json({ success: false, error: "消息不能为空" });
        return;
      }
      // 消息结构白名单校验：role 仅允许 system/user/assistant，content 截断防滥用
      const messages = body.messages.slice(0, 64).map((m) => ({
        role: ["system", "user", "assistant"].includes(m?.role) ? m.role : "user",
        content: String(m?.content ?? "").slice(0, 32_000),
      }));

      // 取所选 Key 明文：默认第一条活跃 Key
      let keyRecord;
      if (typeof body.apiKeyId === "string" && body.apiKeyId) {
        keyRecord = await db.apiKeys.findFirst({
          where: { id: body.apiKeyId, status: "active" },
          select: { id: true, key: true, name: true },
        });
        if (!keyRecord) {
          res.status(400).json({ success: false, error: "所选 API Key 不存在或未启用" });
          return;
        }
      } else {
        keyRecord = await db.apiKeys.findFirst({
          where: { status: "active" },
          orderBy: { createdAt: "desc" },
          select: { id: true, key: true, name: true },
        });
        if (!keyRecord) {
          res.status(400).json({ success: false, error: "尚无可用 API Key，请先在「API Keys」创建" });
          return;
        }
      }

      const upstreamBody: Record<string, unknown> = {
        model,
        messages,
        stream: body.stream === true,
      };
      if (typeof body.temperature === "number" && body.temperature >= 0 && body.temperature <= 2) {
        upstreamBody.temperature = body.temperature;
      }
      if (typeof body.maxTokens === "number" && body.maxTokens > 0) {
        upstreamBody.max_tokens = Math.floor(Math.min(body.maxTokens, 128_000));
      }

      const origin = resolveOrigin(req);
      let upstreamRes: Response;
      try {
        upstreamRes = await fetch(`${origin}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${keyRecord.key}`,
            // 标记来源便于日志排查（v1 日志的 userAgent 列可见）
            "User-Agent": "FWP-Playground/1.0",
          },
          body: JSON.stringify(upstreamBody),
          signal: AbortSignal.timeout(120_000),
        });
      } catch (err) {
        console.error("[POST /api/admin/playground] 回环请求失败:", err instanceof Error ? err.message : String(err));
        res.status(502).json({
          success: false,
          error: "无法回环调用本实例 /v1 入口（当前部署平台可能禁止自调用），请在客户端直连测试",
        });
        return;
      }

      // 审计：Playground 调用会消耗配额与费用，必须留痕
      await db.auditLogs.create({
        data: {
          id: crypto.randomUUID(),
          adminId: getAuditAdminId(admin),
          action: "playground_call",
          detail: JSON.stringify({
            model,
            keyName: keyRecord.name,
            stream: body.stream === true,
          }),
          ip: getClientIp(req),
          createdAt: Math.floor(Date.now() / 1000),
        },
      });

      if (body.stream === true) {
        // SSE 字节透传（与 v1 路由相同的 no-transform 头规避 gzip 缓冲）
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.status(upstreamRes.status);
        const reader = upstreamRes.body?.getReader();
        if (!reader) {
          res.end();
          return;
        }
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
        } finally {
          res.end();
        }
        return;
      }

      // 非流式：透传状态码与 JSON 体
      const text = await upstreamRes.text();
      res.status(upstreamRes.status).setHeader("Content-Type", "application/json");
      res.send(text);
      return;
    }

    res.setHeader("Allow", ["GET", "POST"]);
    res.status(405).json({ success: false, error: { message: "Method not allowed", type: "invalid_request_error" } });
  } catch (error) {
    console.error("[API /api/admin/playground] 操作失败:", error instanceof Error ? error.message : String(error));
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: { message: "操作失败", type: "server_error" } });
    }
  }
}
