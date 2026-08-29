/**
 * API Key 管理 — 单个 Key 操作
 *
 * GET    /api/admin/keys/[id] — 获取单个 Key 的完整密钥（列表接口只返回掩码，
 *        复制功能需要先经此端点取明文；管理员认证 + CSRF 来源校验）
 * PUT    /api/admin/keys/[id] — 更新 API Key 属性
 * DELETE /api/admin/keys/[id] — 删除 API Key（级联删除关联日志与每日统计）
 *
 * 主分支对应文件：src/app/api/admin/keys/[id]/route.ts
 * Pages Router 格式转换
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest, getAuditAdminId, type AuthResult } from "@/lib/admin-auth";
import { getClientIp } from "../auth";
import { checkCsrfOrigin } from "@/lib/admin-security";
import { checkAdminRateLimit } from "@/lib/admin-rate-limit";
import { invalidateApiKeyCache } from "../../../../worker/src/auth";
import { resetAllowlistCache } from "../../../../worker/src/api-key-allowlist";

function maskKey(key: string): string {
  if (key.length > 12) return key.substring(0, 8) + "..." + key.substring(key.length - 4);
  return "***";
}

/**
 * 解析白名单字段（IP 段或模型 ID 列表）
 * - null → null（清空白名单，不限制）
 * - 字符串数组 → JSON 字符串存储
 * - 空数组 → null（视为不限制）
 * - 非数组 → 拒绝
 */
function parseAllowlistField(value: unknown, fieldName: string): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === null) return { ok: true, value: null };
  if (value === undefined) return { ok: true, value: undefined as unknown as string | null };
  if (!Array.isArray(value)) {
    return { ok: false, error: `${fieldName} 必须是字符串数组` };
  }
  if (value.length === 0) return { ok: true, value: null };
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      return { ok: false, error: `${fieldName} 数组元素必须是非空字符串` };
    }
    if (item.length > 200) {
      return { ok: false, error: `${fieldName} 数组元素长度不能超过 200 字符` };
    }
  }
  return { ok: true, value: JSON.stringify(value) };
}

function generateId(): string { return crypto.randomUUID(); }
function now(): number { return Math.floor(Date.now() / 1000); }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const admin = await getAdminFromRequest(req);
  if (!admin) return res.status(401).json({ success: false, error: "未授权" });

  const id = req.query.id as string;
  if (!id) return res.status(400).json({ success: false, error: { message: "缺少 Key ID", type: "invalid_request_error" } });

  switch (req.method) {
    case "GET":
      return handleGetSecret(req, res, id);
    case "PUT":
      if (!checkCsrfOrigin(req, res)) return;
      if (!(await checkAdminRateLimit(admin.adminId, res))) return;
      return handlePut(req, res, admin, id);
    case "DELETE":
      if (!checkCsrfOrigin(req, res)) return;
      if (!(await checkAdminRateLimit(admin.adminId, res))) return;
      return handleDelete(req, res, admin, id);
    default:
      res.setHeader("Allow", ["GET", "PUT", "DELETE"]);
      return res.status(405).json({ success: false, error: "方法不允许" });
  }
}

/** 获取单个 Key 的完整密钥（列表/更新接口均只返回掩码） */
async function handleGetSecret(req: NextApiRequest, res: NextApiResponse, id: string) {
  if (!checkCsrfOrigin(req, res)) return;
  try {
    const db = await createDb();
    const existing = await db.apiKeys.findFirst({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, error: { message: "API Key 不存在", type: "invalid_request_error" } });
    return res.status(200).json({ success: true, data: { id, key: existing.key } });
  } catch (err) {
    console.error("[GET /api/admin/keys/[id]] 获取密钥失败:", err instanceof Error ? err.message : String(err));
    return res.status(500).json({ success: false, error: { message: "获取 API Key 失败", type: "server_error" } });
  }
}

async function handlePut(req: NextApiRequest, res: NextApiResponse, admin: { adminId: string; username: string }, id: string) {
  try {
    const db = await createDb();
    const existing = await db.apiKeys.findFirst({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, error: { message: "API Key 不存在", type: "invalid_request_error" } });

    const body = req.body as any;
    const numericFields = ["rpmLimit", "tpmLimit", "callLimit"] as const;
    for (const field of numericFields) {
      if (body[field] !== undefined && body[field] !== null) {
        if (typeof body[field] !== "number" || !Number.isInteger(body[field]) || body[field] < 0) {
          return res.status(400).json({ success: false, error: { message: `${field} 必须是非负整数`, type: "invalid_request_error" } });
        }
      }
    }
    if (body.tokenLimit !== undefined && body.tokenLimit !== null) {
      if (typeof body.tokenLimit !== "number" || !Number.isFinite(body.tokenLimit)) {
        return res.status(400).json({ success: false, error: { message: "tokenLimit 必须是有效数字", type: "invalid_request_error" } });
      }
      if (!Number.isInteger(body.tokenLimit) || body.tokenLimit < 0) {
        return res.status(400).json({ success: false, error: { message: "tokenLimit 必须是非负整数", type: "invalid_request_error" } });
      }
    }
    if (body.name !== undefined) {
      if (typeof body.name !== "string") {
        return res.status(400).json({ success: false, error: { message: "Key 名称必须是字符串", type: "invalid_request_error" } });
      }
      if (body.name.length > 100) {
        return res.status(400).json({ success: false, error: { message: "Key 名称不能超过 100 个字符", type: "invalid_request_error" } });
      }
    }
    if (body.status !== undefined) {
      const allowed = ["active", "disabled", "expired"];
      if (!allowed.includes(body.status)) {
        return res.status(400).json({ success: false, error: { message: `status 无效，允许值：${allowed.join(", ")}`, type: "invalid_request_error" } });
      }
    }
    if (body.resetPeriod !== undefined) {
      const valid = ["monthly", "daily", "never"];
      if (!valid.includes(body.resetPeriod)) {
        return res.status(400).json({ success: false, error: { message: "重置周期必须是 monthly、daily 或 never", type: "invalid_request_error" } });
      }
    }

    let expiresAtTimestamp: number | null | undefined;
    if (body.expiresAt !== undefined) {
      if (body.expiresAt === null) {
        expiresAtTimestamp = null;
      } else {
        const parsed = new Date(body.expiresAt);
        if (isNaN(parsed.getTime())) return res.status(400).json({ success: false, error: { message: "expiresAt 日期格式无效", type: "invalid_request_error" } });
        expiresAtTimestamp = Math.floor(parsed.getTime() / 1000);
      }
    }

    // 解析白名单字段：null 表示清空，undefined 表示不更新
    const allowedIpsResult = parseAllowlistField(body.allowedIps, "allowedIps");
    if (!allowedIpsResult.ok) {
      return res.status(400).json({ success: false, error: { message: allowedIpsResult.error, type: "invalid_request_error" } });
    }
    const allowedModelsResult = parseAllowlistField(body.allowedModels, "allowedModels");
    if (!allowedModelsResult.ok) {
      return res.status(400).json({ success: false, error: { message: allowedModelsResult.error, type: "invalid_request_error" } });
    }

    const currentTime = now();
    const updateData: Record<string, unknown> = { updatedAt: currentTime };
    if (body.name !== undefined) updateData.name = body.name.trim();
    if (body.rpmLimit !== undefined) updateData.rpmLimit = body.rpmLimit ?? null;
    if (body.tpmLimit !== undefined) updateData.tpmLimit = body.tpmLimit ?? null;
    if (body.callLimit !== undefined) updateData.callLimit = body.callLimit ?? null;
    if (body.tokenLimit !== undefined) updateData.tokenLimit = body.tokenLimit ?? null;
    if (body.resetPeriod !== undefined) updateData.resetPeriod = body.resetPeriod;
    if (body.status !== undefined) updateData.status = body.status;
    if (expiresAtTimestamp !== undefined) updateData.expiresAt = expiresAtTimestamp;
    // 白名单：undefined = 不更新（PATCH 语义），null = 清空（显式设空），数组 = 覆盖
    if (body.allowedIps !== undefined) updateData.allowedIps = allowedIpsResult.value;
    if (body.allowedModels !== undefined) updateData.allowedModels = allowedModelsResult.value;
    // parseAllowlistField 用哨兵值 undefined-as-null 区分"不更新"与"显式清空"；
    // 上面已通过 body.allowedIps !== undefined 过滤，此处同步保证 updateData.value 一致

    // 审计先于写入（config.ts 不变量）：审计失败时抛错返回 500，update 不执行，
    // 避免「配置已生效但无审计」的假成功。changes 引用的是即将写入的请求体数据
    const sanitizedChanges = { ...body };
    if (sanitizedChanges.key) sanitizedChanges.key = String(sanitizedChanges.key).substring(0, 8) + "***";

    const ip = getClientIp(req);
    await db.auditLogs.create({
      data: {
        id: generateId(), adminId: getAuditAdminId(admin as AuthResult), action: "update_api_key",
        detail: JSON.stringify({ target: id, keyId: id, changes: sanitizedChanges }),
        ip, createdAt: currentTime,
      },
    });

    const updated = await db.apiKeys.update({ where: { id }, data: updateData });

    // 更新后立即失效该 Key 的进程内缓存（5s TTL 内的旧白名单会继续生效）
    invalidateApiKeyCache(updated.key);
    // 白名单解析缓存全量清除
    resetAllowlistCache();

    return res.status(200).json({ success: true, data: { ...updated, key: maskKey(updated.key), usedTokens: Number(updated.usedTokens) }, message: "API Key 更新成功" });
  } catch (err) {
    console.error("[PUT /api/admin/keys/[id]] 更新失败:", err instanceof Error ? err.message : String(err));
    return res.status(500).json({ success: false, error: { message: "更新 API Key 失败", type: "server_error" } });
  }
}

async function handleDelete(req: NextApiRequest, res: NextApiResponse, admin: { adminId: string; username: string }, id: string) {
  try {
    const db = await createDb();
    const existing = await db.apiKeys.findFirst({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, error: { message: "API Key 不存在", type: "invalid_request_error" } });

    // 审计先于写入（config.ts 不变量）：审计 detail 所需数据（记录名、待删日志数）
    // 先行查询；审计失败时抛错返回 500，下方任何删除都不会执行
    const pendingLogCount = await db.requestLogs.count({ where: { keyId: id } });

    const currentTime = now();
    const ip = getClientIp(req);
    await db.auditLogs.create({
      data: {
        id: generateId(), adminId: getAuditAdminId(admin as AuthResult), action: "delete_api_key",
        detail: JSON.stringify({ target: id, keyId: id, name: existing.name, deletedLogs: pendingLogCount }),
        ip, createdAt: currentTime,
      },
    });

    const deletedLogsResult = await db.requestLogs.deleteMany({ where: { keyId: id } });
    // 级联清理每日统计：否则日志已删而 daily_stats 残留，仪表盘历史统计与日志页数据矛盾
    await db.dailyStats.deleteMany({ where: { keyId: id } });
    await db.apiKeys.delete({ where: { id } });

    return res.status(200).json({ success: true, message: "API Key 删除成功", deletedLogs: deletedLogsResult.count });
  } catch (err) {
    console.error("[DELETE /api/admin/keys/[id]] 删除失败:", err instanceof Error ? err.message : String(err));
    return res.status(500).json({ success: false, error: { message: "删除 API Key 失败", type: "server_error" } });
  }
}
