/**
 * 时区工具
 *
 * 自动根据用户浏览器时区格式化时间显示。
 * API 返回 ISO 字符串或 Unix 时间戳，前端统一转为本地时间。
 */

/** 获取用户浏览器时区 */
export function getUserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** 格式化 ISO 时间字符串为本地时间（秒级精度） */
export function formatDateTime(isoOrTimestamp: string | number): string {
  const date = typeof isoOrTimestamp === "number"
    ? new Date(isoOrTimestamp * 1000)
    : new Date(isoOrTimestamp);
  return date.toLocaleString();
}

/** 格式化为本地日期（年-月-日） */
export function formatDate(isoOrTimestamp: string | number): string {
  const date = typeof isoOrTimestamp === "number"
    ? new Date(isoOrTimestamp * 1000)
    : new Date(isoOrTimestamp);
  return date.toLocaleDateString();
}

/** 格式化为本地时间（时:分:秒） */
export function formatTime(isoOrTimestamp: string | number): string {
  const date = typeof isoOrTimestamp === "number"
    ? new Date(isoOrTimestamp * 1000)
    : new Date(isoOrTimestamp);
  return date.toLocaleTimeString();
}
