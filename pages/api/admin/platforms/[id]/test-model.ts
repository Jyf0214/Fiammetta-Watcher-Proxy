/**
 * 平台模型可用性测试 API
 *
 * POST /api/admin/platforms/:id/test-model — 对指定模型用平台所有密钥逐个发送真实流式 chat 请求
 *
 * body: { modelId: string }
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/admin-auth";
import { checkCsrfOrigin, isSafeUrl } from "@/lib/admin-security";

/** 测试超时（毫秒） */
const TEST_TIMEOUT_MS = 30_000;

interface TestResult {
  name: string;
  keyMasked: string;
  status: "ok" | "error";
  httpStatus: number;
  latencyMs: number;
  error?: string;
}

/** 解析平台 apiKeys JSON 为命名密钥列表 */
function parseNamedKeyList(raw: string | null | undefined): { name: string; key: string }[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item: unknown, idx: number) => {
        if (typeof item === "string") return { name: `Key${idx + 1}`, key: item };
        if (typeof item === "object" && item !== null && typeof (item as Record<string, unknown>).key === "string") {
          const obj = item as Record<string, unknown>;
          return { name: (typeof obj.name === "string" && obj.name) ? obj.name : `Key${idx + 1}`, key: obj.key as string };
        }
        return null;
      })
      .filter((k): k is { name: string; key: string } => k !== null && k.key.trim().length > 0);
  } catch {
    return [];
  }
}

/** 脱敏密钥：保留前 4 + 后 4，中间用 … 替代 */
function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** 提取错误信息（尝试 JSON 解析，回退纯文本） */
async function extractError(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      if (json.error?.message) return json.error.message;
      if (json.message) return json.message;
      if (json.error) return String(json.error);
      return text.slice(0, 500) || `HTTP ${res.status}`;
    } catch {
      return text.slice(0, 500) || `HTTP ${res.status}`;
    }
  } catch {
    return `HTTP ${res.status}`;
  }
}

/**
 * POST /api/admin/platforms/:id/test-model — 对指定模型用平台所有密钥逐个测试
 */
async function handlePost(req: NextApiRequest, res: NextApiResponse, id: string) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }

  if (!checkCsrfOrigin(req, res)) return;

  try {
    const { modelId } = req.body as { modelId?: string };

    if (!modelId || typeof modelId !== "string" || modelId.trim().length === 0) {
      return res.status(400).json({ success: false, error: "缺少 modelId 参数" });
    }

    const db = await createDb();
    const platform = await db.platforms.findFirst({ where: { id } });

    if (!platform) {
      return res.status(404).json({ success: false, error: "平台不存在" });
    }

    const keys = parseNamedKeyList(platform.apiKeys);
    if (keys.length === 0) {
      return res.status(400).json({ success: false, error: "平台未配置密钥" });
    }

    const urlCheck = await isSafeUrl(platform.baseUrl);
    if (!urlCheck.safe) {
      return res.status(400).json({ success: false, error: `上游 URL 不安全: ${urlCheck.reason}` });
    }

    const chatUrl = `${platform.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const results: TestResult[] = [];

    // 串行测试每个密钥，避免并发触发上游限流
    for (const { name, key } of keys) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
      const start = Date.now();

      try {
        const response = await fetch(chatUrl, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: modelId.trim(),
            messages: [{ role: "user", content: "hi" }],
            stream: true,
            max_tokens: 1,
          }),
          signal: controller.signal,
          redirect: "manual",
        });

        const latencyMs = Date.now() - start;

        if (response.ok) {
          // 消费并取消流式响应体，防止套接字泄漏
          try {
            if (response.body) {
              await response.body.cancel();
            } else {
              await response.text();
            }
          } catch {
            // 响应体取消失败不影响测试结果
          }
          results.push({
            name,
            keyMasked: maskKey(key),
            status: "ok",
            httpStatus: response.status,
            latencyMs,
          });
        } else {
          const errorMsg = await extractError(response);
          results.push({
            name,
            keyMasked: maskKey(key),
            status: "error",
            httpStatus: response.status,
            latencyMs,
            error: errorMsg,
          });
        }
      } catch (err) {
        const latencyMs = Date.now() - start;
        const message = err instanceof Error ? err.message : String(err);
        const isAbort = message.includes("abort");

        results.push({
          name,
          keyMasked: maskKey(key),
          status: "error",
          httpStatus: 0,
          latencyMs,
          error: isAbort ? `请求超时（${TEST_TIMEOUT_MS / 1000}s）` : message,
        });
      } finally {
        clearTimeout(timeout);
      }
    }

    return res.status(200).json({ success: true, data: results });
  } catch (err) {
    console.error("[POST /api/admin/platforms/[id]/test-model] 模型测试失败:", err);
    return res.status(500).json({ success: false, error: "模型测试失败" });
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = String(req.query.id || "");

  switch (req.method) {
    case "POST":
      return handlePost(req, res, id);
    default:
      res.setHeader("Allow", ["POST"]);
      return res.status(405).json({ success: false, error: "方法不允许" });
  }
}
