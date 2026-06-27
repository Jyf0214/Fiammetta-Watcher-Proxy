import { prisma } from "./prisma";
import type { NotificationLevel, NotificationMessage } from "@/types";

// 通知历史（内存中保留最近 100 条）
const notificationHistory: NotificationMessage[] = [];
const MAX_HISTORY = 100;

/**
 * 发送通知并记录到系统事件
 */
async function sendNotification(
  level: NotificationLevel,
  title: string,
  content: string
): Promise<void> {
  const message: NotificationMessage = {
    level,
    title,
    content,
    timestamp: new Date(),
  };

  // 内存历史
  notificationHistory.unshift(message);
  if (notificationHistory.length > MAX_HISTORY) {
    notificationHistory.pop();
  }

  // 写入系统事件
  try {
    await prisma.systemEvent.create({
      data: {
        level,
        message: title,
        detail: JSON.stringify({ content, timestamp: message.timestamp }),
      },
    });
  } catch (err) {
    // 写入事件日志失败不应阻断主流程，但需记录以便排查
    console.error("[notifier] 写入系统事件失败:", err);
  }

  // 发送到外部通知渠道（Telegram / SMTP 等）
  await sendExternalNotification(message);
}

/**
 * 发送到外部通知渠道
 */
async function sendExternalNotification(message: NotificationMessage) {
  // Telegram 通知
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramChatId = process.env.TELEGRAM_CHAT_ID;

  if (telegramToken && telegramChatId) {
    try {
      // 使用纯文本发送，避免 Markdown 注入风险
      const text = `[${message.level.toUpperCase()}] ${message.title}\n\n${message.content}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);
      try {
        await fetch(
          `https://api.telegram.org/bot${telegramToken}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: telegramChatId,
              text,
            }),
            signal: controller.signal,
          }
        );
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      console.error("[notifier] Telegram 通知发送失败:", error);
    }
  }
}

// ==================== 业务通知方法 ====================

/**
 * 通知平台故障
 */
export async function notifyPlatformDown(
  platformId: string,
  failureCount: number
): Promise<void> {
  let platformName = platformId;
  try {
    const platform = await prisma.platform.findUnique({
      where: { id: platformId },
      select: { name: true },
    });
    if (platform) platformName = platform.name;
  } catch {
    // 忽略查询失败
  }

  await sendNotification(
    "error",
    `平台故障: ${platformName}`,
    `平台 "${platformName}" 已连续失败 ${failureCount} 次，已触发自动熔断。请检查上游服务状态。`
  );
}

/**
 * 通知平台恢复
 */
export async function notifyPlatformRecovered(
  platformId: string
): Promise<void> {
  let platformName = platformId;
  try {
    const platform = await prisma.platform.findUnique({
      where: { id: platformId },
      select: { name: true },
    });
    if (platform) platformName = platform.name;
  } catch {
    // 忽略查询失败
  }

  await sendNotification(
    "info",
    `平台恢复: ${platformName}`,
    `平台 "${platformName}" 已恢复正常运行。`
  );
}

/**
 * 通知 API Key 额度用尽
 */
export async function notifyKeyQuotaExhausted(
  keyId: string,
  keyName: string
): Promise<void> {
  await sendNotification(
    "warning",
    `Key 额度用尽: ${keyName}`,
    `API Key "${keyName}" (${keyId}) 的 token 额度已用尽，已被自动禁用。`
  );
}

/**
 * 通知系统异常
 */
export async function notifySystemError(
  error: string,
  detail?: string
): Promise<void> {
  await sendNotification("critical", `系统异常: ${error}`, detail || "");
}

/**
 * 获取最近的通知历史
 */
export function getNotificationHistory(limit: number = 50) {
  return notificationHistory.slice(0, limit);
}
