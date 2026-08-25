/**
 * 模型价格表管理 API
 *
 * GET  /api/admin/pricing        — 获取价格表（configs.system:model_pricing）
 * PUT  /api/admin/pricing        — 全量保存价格表（strict 校验，非法数据 400 拒绝）
 * POST /api/admin/pricing/import — 从 LiteLLM 公开价格源拉取并合并导入
 *
 * 价格语义：美元 / 百万 token。请求路径的成本计算见 src/lib/model-pricing.ts：
 * 上游 usage 自报成本优先采信，无自报时按本表估算。
 *
 * 免责口径：所有费用展示处须注明"仅供参考，实际以服务提供商为准"
 * （i18n key: common.costDisclaimer），估算价与上游实际计费可能存在偏差。
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest, getAuditAdminId } from "@/lib/admin-auth";
import { getClientIp } from "./auth";
import { checkCsrfOrigin } from "@/lib/admin-security";
import { checkAdminRateLimit } from "@/lib/admin-rate-limit";
import {
  MODEL_PRICING_CONFIG_KEY,
  MODEL_PRICING_MAX_ENTRIES,
  parseModelPricing,
  serializeModelPricing,
  type ModelPricingMap,
} from "@/lib/model-pricing";

/**
 * LiteLLM 公开价格源候选（按序回退）。
 *
 * raw.githubusercontent 在部分出网环境（如国内边缘节点）不可达，
 * jsDelivr CDN 镜像同一文件且国内可达性好——故镜像在前、主源兜底。
 * 三源内容一致（同仓库同分支）。
 */
const LITELLM_PRICING_URLS = [
  "https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json",
  "https://fastly.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json",
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
];

async function readPricingFromDb(
  db: Awaited<ReturnType<typeof createDb>>
): Promise<ModelPricingMap> {
  const row = await db.configs.findFirst({
    where: { key: MODEL_PRICING_CONFIG_KEY },
    select: { value: true },
  });
  return parseModelPricing(row?.value ?? null);
}

/** configs.updatedAt 单调递增补偿（与 config.ts nextConfigUpdatedAt 同语义） */
async function nextConfigUpdatedAt(
  db: Awaited<ReturnType<typeof createDb>>,
  key: string
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  let dbUpdatedAt = 0;
  try {
    const row = await db.configs.findFirst({
      where: { key },
      select: { updatedAt: true },
    });
    dbUpdatedAt = row?.updatedAt ?? 0;
  } catch {
    // 读库失败退回进程内单调递增兜底，不阻断保存
  }
  return Math.max(now, dbUpdatedAt + 1);
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
      const pricing = await readPricingFromDb(db);
      res.status(200).json({ success: true, data: pricing });
      return;
    }

    if (req.method === "PUT") {
      if (!checkCsrfOrigin(req, res)) return;
      if (!(await checkAdminRateLimit(admin.adminId, res))) return;

      const body = req.body as { pricing?: unknown };
      if (typeof body.pricing !== "object" || body.pricing === null || Array.isArray(body.pricing)) {
        res.status(400).json({
          success: false,
          error: { message: "请求体必须是 { pricing: {...} } 对象", type: "invalid_request_error" },
        });
        return;
      }

      // strict 校验：任何一条非法（负数/非数字/超上限）整体拒绝，
      // 避免"部分合法部分非法"的脏数据入库后在请求路径被静默丢弃
      let pricing: ModelPricingMap;
      try {
        pricing = parseModelPricing(JSON.stringify(body.pricing), { strict: true });
      } catch (err) {
        res.status(400).json({
          success: false,
          error: {
            message: err instanceof Error ? err.message : "价格表校验失败",
            type: "invalid_request_error",
          },
        });
        return;
      }

      const value = serializeModelPricing(pricing);
      const now = await nextConfigUpdatedAt(db, MODEL_PRICING_CONFIG_KEY);

      // 审计先于写入（与 config.ts 同序）：审计失败则配置不落库，避免假成功
      await db.auditLogs.create({
        data: {
          id: crypto.randomUUID(),
          adminId: getAuditAdminId(admin),
          action: "update_model_pricing",
          detail: JSON.stringify({ models: Object.keys(pricing).length }),
          ip: getClientIp(req),
          createdAt: now,
        },
      });

      await db.configs.upsert({
        where: { key: MODEL_PRICING_CONFIG_KEY },
        create: {
          id: crypto.randomUUID(),
          key: MODEL_PRICING_CONFIG_KEY,
          value,
          updatedAt: now,
        },
        update: { value, updatedAt: now },
      });

      res.status(200).json({ success: true, message: "价格表已更新" });
      return;
    }

    if (req.method === "POST") {
      // POST /api/admin/pricing/import 由 action 参数区分；
      // 默认（无参数或 action=import-litellm）执行 LiteLLM 导入
      if (!checkCsrfOrigin(req, res)) return;
      if (!(await checkAdminRateLimit(admin.adminId, res))) return;

      // 服务端按序尝试候选价格源：任一成功即用；全失败时 502 并附各源
      // 失败原因，便于区分网络不通（超时/连接拒绝）与源异常（HTTP 状态）
      let remote: unknown;
      const tried: string[] = [];
      for (const sourceUrl of LITELLM_PRICING_URLS) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        try {
          const upstream = await fetch(sourceUrl, {
            signal: controller.signal,
            headers: { Accept: "application/json" },
          });
          if (!upstream.ok) {
            tried.push(`${new URL(sourceUrl).host}: HTTP ${upstream.status}`);
            continue;
          }
          remote = await upstream.json();
          break;
        } catch (err) {
          const reason =
            err instanceof Error && err.name === "AbortError"
              ? "超时"
              : err instanceof Error
                ? err.message
                : String(err);
          tried.push(`${new URL(sourceUrl).host}: ${reason}`);
        } finally {
          clearTimeout(timeout);
        }
      }

      if (typeof remote !== "object" || remote === null || Array.isArray(remote)) {
        res.status(502).json({
          success: false,
          error: { message: `所有价格源均不可达（${tried.join("；")}）`, type: "upstream_error" },
        });
        return;
      }

      // LiteLLM 条目：input_cost_per_token / output_cost_per_token 为美元/token，
      // ×1e6 换算为本项目的美元/百万 token。仅收录输入输出价目齐全的条目：
      // 缺失一侧按 0 入库会把"未定价"伪装成"免费"，宁可缺省交由实时计价兜底
      const merged = await readPricingFromDb(db);
      let importedCount = 0;
      for (const [model, raw] of Object.entries(remote as Record<string, unknown>)) {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
        if (Object.keys(merged).length + importedCount >= MODEL_PRICING_MAX_ENTRIES) break;
        const v = raw as Record<string, unknown>;
        const inputPerToken = Number(v.input_cost_per_token);
        const outputPerToken = Number(v.output_cost_per_token);
        if (!Number.isFinite(inputPerToken) || !Number.isFinite(outputPerToken)) continue;
        if (inputPerToken < 0 || outputPerToken < 0) continue;
        const name = model.trim();
        if (!name || name.length > 512) continue;
        merged[name] = {
          input: Math.round(inputPerToken * 1e6 * 1e6) / 1e6,
          output: Math.round(outputPerToken * 1e6 * 1e6) / 1e6,
        };
        importedCount++;
      }

      if (importedCount === 0) {
        res.status(502).json({
          success: false,
          error: { message: "价格源中无可用的完整价目条目", type: "upstream_error" },
        });
        return;
      }

      const value = serializeModelPricing(merged);
      const now = await nextConfigUpdatedAt(db, MODEL_PRICING_CONFIG_KEY);

      await db.auditLogs.create({
        data: {
          id: crypto.randomUUID(),
          adminId: getAuditAdminId(admin),
          action: "import_model_pricing",
          detail: JSON.stringify({ imported: importedCount, total: Object.keys(merged).length }),
          ip: getClientIp(req),
          createdAt: now,
        },
      });

      await db.configs.upsert({
        where: { key: MODEL_PRICING_CONFIG_KEY },
        create: {
          id: crypto.randomUUID(),
          key: MODEL_PRICING_CONFIG_KEY,
          value,
          updatedAt: now,
        },
        update: { value, updatedAt: now },
      });

      res.status(200).json({
        success: true,
        message: "价格表已导入",
        data: { imported: importedCount, total: Object.keys(merged).length },
      });
      return;
    }

    res.setHeader("Allow", ["GET", "PUT", "POST"]);
    res.status(405).json({ success: false, error: { message: "Method not allowed", type: "invalid_request_error" } });
  } catch (error) {
    console.error("[API /api/admin/pricing] 操作失败:", error instanceof Error ? error.message : String(error));
    res.status(500).json({ success: false, error: { message: "操作失败", type: "server_error" } });
  }
}
