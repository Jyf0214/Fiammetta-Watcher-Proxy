/**
 * 全局格式化工具函数 — 各页面共用，避免重复定义
 * 单位后缀通过可选 t 参数走 i18n（如 "秒"/"ms"），不传时退回英文单位
 */

/** ≥1000ms 自动转换为秒，保留两位小数 */
export function formatDuration(
  ms: number,
  t?: (key: string) => string
): { value: string; suffix: string } {
  if (ms >= 1000) {
    return { value: (ms / 1000).toFixed(2), suffix: t ? t("common:unitSec") : "s" };
  }
  return { value: String(Math.round(ms)), suffix: t ? t("common:unitMs") : "ms" };
}

/** 大数字紧凑格式化：≥10亿 → 1.00B，≥100万 → 1.00M，≥1000 → 1.00K */
export function formatCompactNumber(n: number, t?: (key: string) => string): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + (t ? t("common:unitB") : "B");
  if (n >= 1e6) return (n / 1e6).toFixed(2) + (t ? t("common:unitM") : "M");
  if (n >= 1e3) return (n / 1e3).toFixed(2) + (t ? t("common:unitK") : "K");
  return n.toLocaleString();
}

/** 图表轴紧凑格式化：≥10亿 → 1.0B，≥100万 → 1.0M，≥1000 → 1.0K（1位小数，支持负数） */
export function formatCompact(v: number, t?: (key: string) => string): string {
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(1)}${t ? t("common:unitB") : "B"}`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}${t ? t("common:unitM") : "M"}`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}${t ? t("common:unitK") : "K"}`;
  return String(v);
}

/** 根据数值字符串长度动态调整字号 */
export function valueFontSize(v: string): string {
  const len = v.length;
  if (len <= 5) return "text-lg";
  if (len <= 8) return "text-base";
  return "text-sm";
}
