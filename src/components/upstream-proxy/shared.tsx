import { memo } from "react";
import type { TFunction } from "i18next";
import { formatChecked, displayProxyUrl, type ProxyHealthEntry, type ConfigValidationError } from "@/lib/upstream-proxy-ui";

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

/**
 * 单个代理健康行 — memo 化：上游代理池订阅拉取后常达数百上千条，
 * 配置表单输入击键时经 props 浅比较跳过未变化行（entry/stat 由页面 useMemo 稳定）
 */
export const ProxyHealthRow = memo(function ProxyHealthRow({
  url,
  entry,
  degraded,
  stat,
  noStatText,
  t,
}: {
  url: string;
  entry: ProxyHealthEntry | undefined;
  /** 统计降权（路由已跳过）：健康点仍显示 ok 但窗口内错误率过高 */
  degraded: boolean;
  /** 按代理聚合的真实请求统计（仅 Docker 部署传入并渲染统计行） */
  stat?: { total: number; ok: number; err429: number; errOther: number; availability: number };
  /** 有统计区块但无数据时的占位文案（如「暂无请求统计」，非 Docker 不传） */
  noStatText?: string;
  t: TFunction;
}) {
  const status = entry?.status ?? "none";
  return (
    <li className="flex items-start gap-2 text-xs">
      <span
        className={`mt-1 inline-block h-2 w-2 rounded-full shrink-0 ${
          status === "ok"
            ? "bg-emerald-500"
            : status === "fail"
              ? "bg-rose-500"
              : "bg-zinc-300 dark:bg-zinc-600"
        }`}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-zinc-700 dark:text-zinc-300 truncate min-w-0 flex-1">
            {displayProxyUrl(url)}
          </span>
          {degraded && (
            <span
              className="shrink-0 text-[10px] px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400"
              title={t("upstreamProxyDegradedTip")}
            >
              {t("upstreamProxyDegraded")}
            </span>
          )}
          <span className="shrink-0 text-zinc-400 text-right">
            {renderHealthText(status, entry, t)}
          </span>
        </div>
        {stat ? (
          <div className="flex items-center gap-2.5 mt-0.5 text-[10px] text-zinc-400">
            <span>
              {t("upstreamProxyRequests")} {stat.total}
            </span>
            <span className="text-emerald-600 dark:text-emerald-400">
              {t("upstreamProxySuccess")} {stat.ok}
            </span>
            <span className="text-amber-600 dark:text-amber-500">429 {stat.err429}</span>
            <span className="text-rose-500">
              {t("upstreamProxyErrOther")} {stat.errOther}
            </span>
            <span className="text-zinc-500">
              {t("upstreamProxyAvailability")} {Math.round(stat.availability * 100)}%
            </span>
          </div>
        ) : noStatText ? (
          <div className="flex items-center gap-2.5 mt-0.5 text-[10px] text-zinc-400">
            <span>{noStatText}</span>
          </div>
        ) : null}
      </div>
    </li>
  );
});

/** 配置校验错误 → 翻译键（buildConfigJson 返回错误码，组件层映射为字面量供 i18n 检查） */
export const VALIDATION_KEYS: Record<ConfigValidationError, string> = {
  upstreamProxyGroupNameRequired: "upstreamProxyGroupNameRequired",
  upstreamProxyGroupNameDup: "upstreamProxyGroupNameDup",
  upstreamProxyGroupNameReserved: "upstreamProxyGroupNameReserved",
  upstreamProxyInvalidSourceUrl: "upstreamProxyInvalidSourceUrl",
  upstreamProxyInvalidUrls: "upstreamProxyInvalidUrls",
  upstreamProxyInvalidInterval: "upstreamProxyInvalidInterval",
  upstreamProxyInvalidRefreshInterval: "upstreamProxyInvalidRefreshInterval",
};