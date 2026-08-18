import { useEffect, useMemo } from "react";
import { Tag, Tooltip, message, type TableColumnsType } from "antd";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { ProCard } from "@/components/ui/ProCard";
import { formatDuration, formatCompactNumber, valueFontSize } from "@/lib/format";
import { useTranslation } from "react-i18next";
import { Zap, TrendingUp, Globe, AlertTriangle } from "lucide-react";
import "@/lib/i18n";
import { useApi, useRefreshKey, UNAUTHORIZED_MESSAGE } from "@/hooks/use-api";

interface PlatformUsage {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  status: string;
  baseUrl: string;
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
    errorRequests: number;
    firstRequestAt: string | null;
  };
}

interface PlatformUsageTabProps {
  period: string;
  refreshKey: number;
}

export default function PlatformUsageTab({
  period,
  refreshKey,
}: PlatformUsageTabProps) {
  const { t } = useTranslation("usage");

  // 数据层：key 含 period，切换周期时 SWR 自动重新请求
  const { data, error, isValidating, mutate } = useApi<PlatformUsage[]>(
    `/api/admin/usage/platform?period=${period}`
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
      totalRequests: (data ?? []).reduce((s, p) => s + p.stats.totalRequests, 0),
      totalTokens: (data ?? []).reduce((s, p) => s + p.stats.totalTokens, 0),
      activePlatforms: (data ?? []).filter((p) => p.enabled).length,
      errorRequests: (data ?? []).reduce((s, p) => s + p.stats.errorRequests, 0),
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
      key: "activePlatforms",
      title: t("dashboard:activePlatforms"),
      value: summary.activePlatforms,
      suffix: `/ ${(data ?? []).length}`,
      icon: <Globe />,
      bgColor: "bg-slate-100 dark:bg-slate-800/50",
      iconColor: "text-slate-500",
    },
    {
      key: "errors",
      title: t("common:error"),
      value: summary.errorRequests,
      icon: <AlertTriangle />,
      bgColor: "bg-red-50",
      iconColor: "text-red-500",
    },
  ];

  const statusColorMap: Record<string, string> = {
    healthy: "green",
    degraded: "orange",
    down: "red",
  };

  // 状态文案走 i18n（与平台列表页/详情页同口径），未知状态回退原文
  const statusLabelMap: Record<string, string> = {
    healthy: t("platform:statusHealthy"),
    degraded: t("platform:statusDegraded"),
    down: t("platform:statusDown"),
  };

  const columns: TableColumnsType<PlatformUsage> = [
    {
      title: t("platform:name"),
      dataIndex: "name",
      key: "name",
      width: 150,
      ellipsis: true,
    },
    {
      title: t("platform:type"),
      dataIndex: "type",
      key: "type",
      width: 90,
      render: (v: string) => (
        <Tag color={v === "openai" ? "blue" : v === "azure" ? "purple" : "default"}>
          {v}
        </Tag>
      ),
    },
    {
      title: t("status"),
      dataIndex: "status",
      key: "status",
      width: 90,
      align: "center",
      render: (v: string) => (
        <Tag color={statusColorMap[v] || "default"}>{statusLabelMap[v] || v}</Tag>
      ),
    },
    {
      title: t("totalRequests"),
      key: "totalRequests",
      width: 100,
      align: "right",
      render: (_: unknown, record: PlatformUsage) =>
        record.stats.totalRequests.toLocaleString(),
    },
    {
      title: t("totalTokens"),
      key: "totalTokens",
      width: 110,
      align: "right",
      render: (_: unknown, record: PlatformUsage) =>
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
      render: (_: unknown, record: PlatformUsage) =>
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
      render: (_: unknown, record: PlatformUsage) =>
        record.stats.completionTokens.toLocaleString(),
      responsive: ["md"],
    },
    {
      title: t("common:error"),
      key: "errorRequests",
      width: 80,
      align: "right",
      render: (_: unknown, record: PlatformUsage) =>
        record.stats.errorRequests > 0 ? (
          <span className="text-red-500">
            {record.stats.errorRequests.toLocaleString()}
          </span>
        ) : (
          "0"
        ),
      responsive: ["lg"],
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
      render: (_: unknown, record: PlatformUsage) => {
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
      render: (_: unknown, record: PlatformUsage) =>
        record.stats.avgTokensPerSecond > 0
          ? record.stats.avgTokensPerSecond.toFixed(1)
          : "-",
      responsive: ["xl"],
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
      render: (_: unknown, record: PlatformUsage) =>
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
      render: (_: unknown, record: PlatformUsage) => {
        if (record.stats.avgDuration <= 0) return "-";
        const { value, suffix } = formatDuration(record.stats.avgDuration, t);
        return `${value} ${suffix}`;
      },
      responsive: ["xl"],
    },
  ];

  return (
    <>
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 mb-6">
        {statCards.map((card) => {
          const displayVal = formatCompactNumber(card.value, t);
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
                    {card.suffix && (
                      <span className="text-sm font-normal text-zinc-400 ml-1">
                        {card.suffix}
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
        scroll={{ x: 1200 }}
      />
    </>
  );
}
