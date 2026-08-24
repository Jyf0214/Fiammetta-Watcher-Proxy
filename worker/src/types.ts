/**
 * Worker Cron 任务类型定义
 *
 * 仅保留 Cron 调度所需的运行时类型；
 * 平台配置、路由决策、速率限制结果等运行时类型统一使用 @/lib/types。
 */

// ==================== Cron 任务类型 ====================

export type CronTask = "model-fetch" | "key-reset" | "log-archive" | "proxy-health" | "proxy-pull" | "backup";

/** 将 cron 表达式映射到任务类型（精确匹配） */
export function classifyCronExpression(cron: string): CronTask | null {
  const trimmed = cron.trim();
  // 每 6 小时 → 模型发现
  if (trimmed === "0 */6 * * *") return "model-fetch";
  // 每小时 → Key 重置
  if (trimmed === "0 */1 * * *") return "key-reset";
  // 每天凌晨 3 点 → 日志归档
  if (trimmed === "0 3 * * *") return "log-archive";
  // 每 5 分钟 → 出站代理健康检查（Docker 部署且未禁用时生效）
  if (trimmed === "*/5 * * * *") return "proxy-health";
  // 每分钟 → 出站代理列表拉取（按组内部周期判定是否到期，非每分钟都实际拉取）
  if (trimmed === "* * * * *") return "proxy-pull";
  // 每天 3:17 → 配置备份（避开整点与 log-archive 的 3:00）
  if (trimmed === "17 3 * * *") return "backup";
  return null;
}
