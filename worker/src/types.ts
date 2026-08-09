/**
 * Worker Cron 任务类型定义
 *
 * 仅保留 Cron 调度所需的运行时类型；
 * 平台配置、路由决策、速率限制结果等运行时类型统一使用 @/lib/types。
 */

// ==================== Cron 任务类型 ====================

export type CronTask = "model-fetch" | "key-reset" | "log-archive";

/** 将 cron 表达式映射到任务类型（精确匹配） */
export function classifyCronExpression(cron: string): CronTask | null {
  const trimmed = cron.trim();
  // 每 6 小时 → 模型发现
  if (trimmed === "0 */6 * * *") return "model-fetch";
  // 每小时 → Key 重置
  if (trimmed === "0 */1 * * *") return "key-reset";
  // 每天凌晨 3 点 → 日志归档
  if (trimmed === "0 3 * * *") return "log-archive";
  return null;
}
