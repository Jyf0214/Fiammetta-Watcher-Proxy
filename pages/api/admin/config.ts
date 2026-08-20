/**
 * 系统配置管理 API
 *
 * GET  /api/admin/config — 获取系统配置（仅 system:* 前缀）
 * PUT  /api/admin/config — 更新系统配置
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest, getAuditAdminId } from "@/lib/admin-auth";
import { getClientIp } from "./auth";
import { checkCsrfOrigin } from "@/lib/admin-security";
import { checkAdminRateLimit } from "@/lib/admin-rate-limit";
import {
  UPSTREAM_PROXY_CONFIG_KEY,
  UPSTREAM_PROXY_HEALTH_KEY,
  UPSTREAM_PROXY_POOL_KEY,
  UPSTREAM_PROXY_CHECK_LOCK_KEY,
  UPSTREAM_PROXY_PULL_AT_KEY,
  validateUpstreamProxyConfig,
} from "@/lib/upstream-proxy";

/**
 * 内部派生键黑名单：pool（拉取结果）、health（健康度）、check_lock（健康
 * 检查锁/进度）与 pull_at（各组最近成功拉取时刻）由 upstream-proxy 模块
 * 内部写入（cron 拉取/健康检查/失败标记/跨实例互斥租约/组级自动更新计时），
 * 前端保存代理配置走 system:upstream_proxy 主键。若允许 PUT 直写这些键，
 * 可注入任意代理（引流）、伪造/清空健康表（操纵路由）、破坏检查互斥锁或
 * 伪造拉取时间（让某组自动更新停摆/立即重拉），且绕过前端全部格式校验
 * （组名唯一/保留名/interval/URL 合法性）——API 层必须同步拒绝。
 */
const PROTECTED_CONFIG_KEYS = new Set<string>([
  UPSTREAM_PROXY_POOL_KEY,
  UPSTREAM_PROXY_HEALTH_KEY,
  UPSTREAM_PROXY_CHECK_LOCK_KEY,
  UPSTREAM_PROXY_PULL_AT_KEY,
]);

/**
 * configs.updatedAt 为 Int 秒级列（毫秒写入会溢出），同一秒内两次保存会得到
 * 相同 updatedAt；出站代理等模块以「updatedAt 等值比较」做缓存失效检查，
 * 同秒双保存会被判定为无变化、继续返回旧缓存（最长 30s 不生效）。
 * 旧实现以进程内自增补偿（Docker 单实例即完备）——多实例部署下各实例的
 * 补偿互不可见：同一秒内两个实例各自保存会写入相同 updatedAt，甚至倒退
 * （实例 A 已补偿到 t+2，实例 B 仍写 t），跨实例失效检查再次失效。
 * 改为读库取 max：以数据库当前值 +1 为下限，任意实例的写入都相对库中
 * 最新值单调递增（并发读改写同一秒仍可能相同，但上游缓存已改用 value
 * 内容做失效信号，updatedAt 不再承担失效判断职责）。读库失败时退回
 * 进程内补偿兜底，不阻断保存。
 */
let lastConfigSaveAt = 0;

async function nextConfigUpdatedAt(db: Awaited<ReturnType<typeof createDb>>, key: string): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  let dbUpdatedAt = 0;
  try {
    const row = await db.configs.findFirst({
      where: { key },
      select: { updatedAt: true },
    });
    dbUpdatedAt = row?.updatedAt ?? 0;
  } catch (err) {
    console.error("[API /api/admin/config] 读取配置 updatedAt 失败，退化为进程内补偿:", err);
  }
  lastConfigSaveAt = Math.max(now, dbUpdatedAt + 1, lastConfigSaveAt + 1);
  return lastConfigSaveAt;
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
      // 查询所有 system: 前缀的配置
      const configs = await db.configs.findMany({
        where: { key: { startsWith: "system:" } },
      });

      const data: Record<string, string> = {};
      for (const c of configs) {
        data[c.key] = c.value;
      }

      res.status(200).json({ success: true, data });
      return;
    }

    if (req.method === "PUT") {
      if (!checkCsrfOrigin(req, res)) return;
      // 写操作限流：与其它管理写端点一致按 adminId 计数（#38）
      if (!(await checkAdminRateLimit(admin.adminId, res))) return;

      const body = req.body as { key?: string; value?: string };

      // 验证配置键必须以 system: 开头
      if (!body.key || typeof body.key !== "string" || !body.key.startsWith("system:")) {
        res.status(400).json({ success: false, error: { message: "配置键必须以 system: 开头", type: "invalid_request_error" } });
        return;
      }

      // 内部派生键禁止直写（见 PROTECTED_CONFIG_KEYS 说明）
      if (PROTECTED_CONFIG_KEYS.has(body.key)) {
        res.status(400).json({ success: false, error: { message: "该配置键受保护，禁止直接修改", type: "invalid_request_error" } });
        return;
      }

      // 验证配置值不能为空
      if (body.value === undefined || body.value === null || typeof body.value !== "string") {
        res.status(400).json({ success: false, error: { message: "配置值不能为空", type: "invalid_request_error" } });
        return;
      }

      // 代理配置主键：写入前严格校验（合法 JSON、组名/URL/周期/绑定完整性）。
      // 此前非法 JSON body 直接入库并返回 200 假成功，前端解析回退旧版格式、
      // normalizeConfig 丢弃指向缺失组的绑定，表现为「绑定保存后消失」——
      // 保存路径必须在写入前 400 拒绝（详见 validateUpstreamProxyConfig 说明）
      if (body.key === UPSTREAM_PROXY_CONFIG_KEY) {
        const validation = validateUpstreamProxyConfig(body.value);
        if (!validation.ok) {
          res.status(400).json({ success: false, error: { message: validation.error, type: "invalid_request_error" } });
          return;
        }
      }

      // 单调递增补偿：相对库中当前 updatedAt 取 max（见 nextConfigUpdatedAt 说明）
      const now = await nextConfigUpdatedAt(db, body.key);

      // 审计日志：配置修改属安全敏感操作（可含代理地址等），记录变更内容；
      // 值内嵌的 user:pass 凭据按 maskProxyUrl 同规则脱敏，防止凭据在审计表
      // 长期可读。审计先于 upsert 写入：审计写入失败时主流程抛错返回 500，
      // 配置不会落库——避免「配置已生效但无审计」的假成功（TiDB HTTP 适配器
      // 下 $transaction 不可依赖，改为按顺序先审计后写入）
      const ip = getClientIp(req);
      await db.auditLogs.create({
        data: {
          id: crypto.randomUUID(),
          adminId: getAuditAdminId(admin),
          action: "update_config",
          detail: JSON.stringify({
            key: body.key,
            value: body.value.replace(/\/\/[^@\s]+@/g, "//***@"),
          }),
          ip,
          createdAt: now,
        },
      });

      // 使用 Prisma upsert 实现 upsert（configs.key 是唯一约束）
      await db.configs.upsert({
        where: { key: body.key },
        create: {
          id: crypto.randomUUID(),
          key: body.key,
          value: body.value,
          updatedAt: now,
        },
        update: {
          value: body.value,
          updatedAt: now,
        },
      });

      res.status(200).json({ success: true, message: "配置已更新" });
      return;
    }

    // 不支持的 HTTP 方法
    res.setHeader("Allow", ["GET", "PUT"]);
    res.status(405).json({ success: false, error: { message: "Method not allowed", type: "invalid_request_error" } });
  } catch (error) {
    console.error(`[API /api/admin/config] 操作失败:`, error instanceof Error ? error.message : String(error));
    res.status(500).json({ success: false, error: { message: "操作失败", type: "server_error" } });
  }
}
