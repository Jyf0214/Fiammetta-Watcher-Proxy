import type { TFunction } from "i18next";
import { formatChecked, type ProxyHealthEntry, type ConfigValidationError } from "@/lib/upstream-proxy-ui";

/** 健康状态文案（含检查时间；组内列表与健康面板共用） */
export function renderHealthText(
  status: "ok" | "fail" | "none",
  entry: ProxyHealthEntry | undefined,
  t: TFunction
): string {
  if (status === "ok" && entry) {
    return `${t("upstreamProxyStatusOk")} · ${entry.latencyMs}ms${entry.checkedAt > 0 ? ` · ${t("upstreamProxyCheckedAt")}${formatChecked(entry.checkedAt)}` : ""}`;
  }
  if (status === "fail" && entry) {
    return `${t("upstreamProxyStatusFail")} · ${entry.failCount}${t("upstreamProxyFailCountSuffix")}${entry.checkedAt > 0 ? ` · ${t("upstreamProxyCheckedAt")}${formatChecked(entry.checkedAt)}` : ""}`;
  }
  return t("upstreamProxyStatusNone");
}

/** 配置校验错误 → 翻译键（buildConfigJson 返回错误码，组件层映射为字面量供 i18n 检查） */
export const VALIDATION_KEYS: Record<ConfigValidationError, string> = {
  upstreamProxyGroupNameRequired: "upstreamProxyGroupNameRequired",
  upstreamProxyGroupNameDup: "upstreamProxyGroupNameDup",
  upstreamProxyGroupNameReserved: "upstreamProxyGroupNameReserved",
  upstreamProxyInvalidSourceUrl: "upstreamProxyInvalidSourceUrl",
  upstreamProxyInvalidUrls: "upstreamProxyInvalidUrls",
  upstreamProxyInvalidInterval: "upstreamProxyInvalidInterval",
};