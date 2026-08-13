import { useEffect, useMemo } from "react";
import { Tag, Tooltip, message, type TableColumnsType } from "antd";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { ProCard } from "@/components/ui/ProCard";
import { formatDuration, formatCompactNumber, valueFontSize } from "@/lib/format";
import { useTranslation } from "react-i18next";
import { Zap, TrendingUp, Cloud, Clock } from "lucide-react";
import "@/lib/i18n";
import { useApi, useRefreshKey, UNAUTHORIZED_MESSAGE } from "@/hooks/use-api";

interface KeyUsage {
  id: string;
  name: string;
  key: string;
  status: string;
  tokenLimit: number | null;
  usedTokens: number;
  createdAt: string;
  stats: {
    totalRequests: number;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    avgTtft: number;
    avgDuration: number;
    avgTokensPerSecond: number;
    avgRequestsPerMinute: number;
    firstRequestAt: string | null;
  };
}

interface KeyUsageTabProps {
  period: string;
  refreshKey: number;
}

export default function KeyUsageTab({ period, refreshKey }: KeyUsageTabProps) {
  const { t } = useTranslation("usage");

  // 数据层：key 含 period，切换周期时 SWR 自动重新请求
  const { data, error, isValidating, mutate } = useApi<KeyUsage[]>(
    `/api/admin/usage?period=${period}`
  );

  // 父页面刷新按钮（refreshKey 计数）触发重新验证
  useRefreshKey(refreshKey, mutate);

  // 请求失败提示（401 已由 fetcher 统一提示并跳转登录页）
  useEffect(() => {
    if (error && error.message !== UNAUTHORIZED_MESSAGE) {
      message.error(t("common:error"));
    }
  }, [error, t]);

  // 汇总
  const summary = useMemo(
    () => ({
      totalRequests: (data ?? []).reduce((s, k) => s + k.stats.totalRequests, 0),
      totalTokens: (data ?? []).reduce((s, k) => s + k.stats.totalTokens, 0),
      activeKeys: (data ?? []).filter((k) => k.status === "active").length,
      avgTtft:
        (data ?? []).length > 0
          ? Math.round(
              (data ?? []).reduce((s, k) => s + k.stats.avgTtft, 0) / (data ?? []).length
            )
          : 0,
    }),
    [data]
  );

  const statCards = [
    {
      key: "requests",
      title: t("totalRequests"),
      value: summary.totalRequests,
      icon: <Zap />,
      bgColor: "bg-zinc-100 dark:bg-zinc-800",
      iconColor: "text-zinc-600 dark:text-zinc-400",
    },
    {
      key: "tokens",
      title: t("totalTokens"),
      value: summary.totalTokens,
      icon: <TrendingUp />,
      bgColor: "bg-emerald-50 dark:bg-emerald-900/20",
      iconColor: "text-emerald-500",
    },
    {
      key: "activeKeys",
      title: t("activeKeys"),
      value: summary.activeKeys,
      suffix: `/ ${(data ?? []).length}`,
      icon: <Cloud />,
      bgColor: "bg-slate-100 dark:bg-slate-800/50",
      iconColor: "text-slate-500",
    },
    {
      key: "ttft",
      title: t("avgTtft"),
      value: summary.avgTtft,
      icon: <Clock />,
      bgColor: "bg-amber-50",
      iconColor: "text-amber-500",
      get display() { return formatDuration(this.value, t); },
    },
  ];

  const columns: TableColumnsType<KeyUsage> = [
    {
      title: t("keyName"),
      dataIndex: "name",
      key: "name",
      width: 140,
      ellipsis: true,
    },
    {
      title: t("key"),
      dataIndex: "key",
      key: "key",
      width: 160,
      render: (v: string) => (
        <span className="font-mono text-xs">{v}</span>
      ),
    },
    {
      title: t("status"),
      dataIndex: "status",
      key: "status",
      width: 90,
      align: "center",
      render: (v: string) => (
        <Tag color={v === "active" ? "green" : "red"}>
          {v === "active" ? t("common:enable") : t("common:disable")}
        </Tag>
      ),
    },
    {
      title: t("totalRequests"),
      key: "totalRequests",
      width: 100,
      align: "right",
      render: (_: unknown, record: KeyUsage) =>
        record.stats.totalRequests.toLocaleString(),
    },
    {
      title: t("totalTokens"),
      key: "totalTokens",
      width: 110,
      align: "right",
      render: (_: unknown, record: KeyUsage) =>
        record.stats.totalTokens.toLocaleString(),
    },
    {
      title: (
        <Tooltip title={t("promptTokensDesc")}>
          {t("promptTokens")}
        </Tooltip>
      ),
      key: "promptTokens",
      width: 100,
      align: "right",
      render: (_: unknown, record: KeyUsage) =>
        record.stats.promptTokens.toLocaleString(),
      responsive: ["md"],
    },
    {
      title: (
        <Tooltip title={t("completionTokensDesc")}>
          {t("completionTokens")}
        </Tooltip>
      ),
      key: "completionTokens",
      width: 100,
      align: "right",
      render: (_: unknown, record: KeyUsage) =>
        record.stats.completionTokens.toLocaleString(),
      responsive: ["md"],
    },
    {
      title: (
        <Tooltip title={t("avgTtftDesc")}>
          {t("avgTtft")}
        </Tooltip>
      ),
      key: "avgTtft",
      width: 100,
      align: "right",
      render: (_: unknown, record: KeyUsage) => {
        if (record.stats.avgTtft <= 0) return "-";
        const { value, suffix } = formatDuration(record.stats.avgTtft, t);
        return `${value} ${suffix}`;
      },
      responsive: ["lg"],
    },
    {
      title: (
        <Tooltip title={t("avgTpsDesc")}>
          {t("avgTps")}
        </Tooltip>
      ),
      key: "avgTokensPerSecond",
      width: 110,
      align: "right",
      render: (_: unknown, record: KeyUsage) =>
        record.stats.avgTokensPerSecond > 0
          ? record.stats.avgTokensPerSecond.toFixed(1)
          : "-",
      responsive: ["lg"],
    },
    {
      title: (
        <Tooltip title={t("avgRpmDesc")}>
          {t("avgRpm")}
        </Tooltip>
      ),
      key: "avgRequestsPerMinute",
      width: 100,
      align: "right",
      render: (_: unknown, record: KeyUsage) =>
        record.stats.avgRequestsPerMinute > 0
          ? record.stats.avgRequestsPerMinute.toFixed(1)
          : "-",
      responsive: ["xl"],
    },
    {
      title: t("avgDuration"),
      key: "avgDuration",
      width: 100,
      align: "right",
      render: (_: unknown, record: KeyUsage) => {
        if (record.stats.avgDuration <= 0) return "-";
        const { value, suffix } = formatDuration(record.stats.avgDuration, t);
        return `${value} ${suffix}`;
      },
      responsive: ["xl"],
    },
    {
      title: t("tokenLimit"),
      key: "tokenLimit",
      width: 100,
      align: "right",
      render: (_: unknown, record: KeyUsage) =>
        record.tokenLimit
          ? record.tokenLimit.toLocaleString()
          : t("common:unlimited"),
      responsive: ["xl"],
    },
  ];

  return (
    <>
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 mb-6">
        {statCards.map((card) => {
          const display = "display" in card ? card.display : null;
          const displayVal = display ? display.value : formatCompactNumber(card.value, t);
          const suffix = display?.suffix ?? card.suffix;
          return (
            <ProCard key={card.key} className="bg-white border-zinc-200" padding="p-3">
              <div className="flex items-center gap-2.5">
                <div
                  className={`h-8 w-8 ${card.bgColor} rounded-lg flex items-center justify-center shrink-0`}
                >
                  <span className={`${card.iconColor} text-sm`}>{card.icon}</span>
                </div>
                <div className="min-w-0">
                  <p className="text-zinc-500 text-[11px] leading-tight truncate mb-0.5">{card.title}</p>
                  <p className={`${valueFontSize(displayVal)} font-bold text-zinc-900 leading-tight tabular-nums whitespace-nowrap`}>
                    {displayVal}
                    {suffix && (
                      <span className="text-sm font-normal text-zinc-400 ml-1">
                        {suffix}
                      </span>
                    )}
                  </p>
                </div>
              </div>
            </ProCard>
          );
        })}
      </div>

      {/* 明细表格 */}
      <ResponsiveTable
        columns={columns}
        dataSource={data ?? []}
        rowKey="id"
        loading={isValidating}
        pagination={{
          pageSize: 20,
          showTotal: (count) => t("common:pagination", { count }),
        }}
        scroll={{ x: 1400 }}
      />
    </>
  );
}
