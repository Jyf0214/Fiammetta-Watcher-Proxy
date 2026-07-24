/**
 * 全局格式化工具函数 — 各页面共用，避免重复定义
 */

/** ≥1000ms 自动转换为秒，保留两位小数 */
export function formatDuration(ms: number): { value: string; suffix: string } {
  if (ms >= 1000) {
    return { value: (ms / 1000).toFixed(2), suffix: "s" };
  }
  return { value: String(Math.round(ms)), suffix: "ms" };
}

/** 大数字紧凑格式化：≥10亿 → 1.00B，≥100万 → 1.00M，≥1000 → 1.00K */
export function formatCompactNumber(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toLocaleString();
}

/** 图表轴紧凑格式化：≥10亿 → 1.0B，≥100万 → 1.0M，≥1000 → 1.0K（1位小数，支持负数） */
export function formatCompact(v: number): string {
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

/** 根据数值字符串长度动态调整字号 */
export function valueFontSize(v: string): string {
  const len = v.length;
  if (len <= 5) return "text-lg";
  if (len <= 8) return "text-base";
  return "text-sm";
}
