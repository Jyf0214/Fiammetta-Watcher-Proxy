/**
 * 通知测试发送端点
 *
 * POST /api/admin/notifications/test
 * body: { channelId: string, event?: NotificationEvent, title: string, body: string }
 *
 * 行为：取指定通道配置，渲染 payload 模板，POST 到该通道 URL；
 * 返回 { ok, status, durationMs, error? }。写一条 status=success/failed 的 history。
 * 旁路：测试发送不计入冷却（用 eventKey="test-send" 区分），不触发 backup_failed 通知。
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/admin-auth";
import { checkCsrfOrigin } from "@/lib/admin-security";
import { checkAdminRateLimit } from "@/lib/admin-rate-limit";
import {
  parseNotificationsConfig,
  type NotificationEvent,
} from "@/lib/notifier";
import { renderNotificationRequest } from "@/lib/notification-channels";
import { recordHistory } from "@/lib/notification-store";
import { isSafeUpstreamUrl } from "@/lib/ssrf";

const NOTIFICATIONS_CONFIG_KEY = "system:notifications";
const SEND_TIMEOUT_MS = 5_000;

const VALID_EVENTS: ReadonlySet<NotificationEvent> = new Set<NotificationEvent>([
  "key_banned",
  "platform_circuit_tripped",
  "platform_recovered",
  "platform_degraded",
  "all_unavailable",
  "quota_threshold",
  "key_manually_disabled",
  "backup_failed",
]);

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    res.status(401).json({ success: false, error: "未授权" });
    return;
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    res.status(405).json({ success: false, error: { message: "Method not allowed", type: "invalid_request_error" } });
    return;
  }
  if (!checkCsrfOrigin(req, res)) return;
  if (!(await checkAdminRateLimit(admin.adminId, res))) return;

  try {
    const input = req.body as { channelId?: unknown; event?: unknown; title?: unknown; body?: unknown };
    if (typeof input.channelId !== "string" || !input.channelId) {
      res.status(400).json({
        success: false,
        error: { message: "channelId 必填且必须是字符串", type: "invalid_request_error" },
      });
      return;
    }
    if (typeof input.title !== "string" || !input.title) {
      res.status(400).json({
        success: false,
        error: { message: "title 必填且必须是字符串", type: "invalid_request_error" },
      });
      return;
    }
    if (typeof input.body !== "string") {
      res.status(400).json({
        success: false,
        error: { message: "body 必须是字符串", type: "invalid_request_error" },
      });
      return;
    }
    const event: NotificationEvent =
      typeof input.event === "string" && VALID_EVENTS.has(input.event as NotificationEvent)
        ? (input.event as NotificationEvent)
        : "key_banned"; // 测试发送默认用 key_banned 模板

    // 读取通道配置
    const db = await createDb();
    const row = await db.configs.findFirst({
      where: { key: NOTIFICATIONS_CONFIG_KEY },
      select: { value: true },
    });
    const config = parseNotificationsConfig(row?.value ?? null);
    const channel = config.channels.find((c) => c.id === input.channelId);
    if (!channel) {
      res.status(404).json({
        success: false,
        error: { message: `通道 ${input.channelId} 不存在`, type: "not_found" },
      });
      return;
    }
    if (channel.type === "backup") {
      res.status(400).json({
        success: false,
        error: { message: "backup 类型通道请用 /api/admin/backup/test 测试", type: "invalid_request_error" },
      });
      return;
    }

    // 渲染 payload
    const rendered = renderNotificationRequest({
      title: input.title,
      body: input.body,
      event,
      channel,
    });
    if (!rendered) {
      res.status(400).json({
        success: false,
        error: { message: `通道 ${channel.name} 类型 ${channel.type} 渲染失败`, type: "invalid_request_error" },
      });
      return;
    }

    // SSRF 二次防御（虽然 parse 阶段已挡，但管理员可能直接改 DB）
    const ssrf = isSafeUpstreamUrl(rendered.url);
    if (!ssrf.safe) {
      res.status(400).json({
        success: false,
        error: { message: `通道 URL 内网或本地地址：${ssrf.reason ?? "不安全"}`, type: "invalid_request_error" },
      });
      return;
    }

    // 实际发送
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    let status: "success" | "failed" = "failed";
    let httpStatus: number | null = null;
    let error: string | null = null;
    try {
      const res2 = await fetch(rendered.url, {
        method: "POST",
        headers: rendered.headers,
        body: rendered.body,
        signal: controller.signal,
      });
      httpStatus = res2.status;
      if (typeof res2.arrayBuffer === "function") {
        try {
          await res2.arrayBuffer();
        } catch {
          await res2.body?.cancel().catch(() => {});
        }
      }
      if (res2.ok) {
        status = "success";
      } else {
        error = `HTTP ${res2.status}`;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }
    const durationMs = Date.now() - start;

    // 写 history（不计入通知发送冷却，因为不走 sendNotification）
    await recordHistory({
      channelId: channel.id,
      channelName: `${channel.name} (测试)`,
      channelType: channel.type,
      event,
      title: input.title,
      body: input.body,
      status,
      httpStatus,
      error,
      sizeBytes: new TextEncoder().encode(rendered.body).length,
      durationMs,
    });

    if (status === "success") {
      res.status(200).json({
        success: true,
        data: { ok: true, status: httpStatus, durationMs },
      });
    } else {
      res.status(502).json({
        success: false,
        data: { ok: false, status: httpStatus, error, durationMs },
      });
    }
  } catch (err) {
    console.error(
      "[API /api/admin/notifications/test] 操作失败:",
      err instanceof Error ? err.message : String(err)
    );
    res.status(500).json({ success: false, error: { message: "操作失败", type: "server_error" } });
  }
}
