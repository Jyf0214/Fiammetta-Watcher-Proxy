import { useState, useEffect, useMemo } from "react";
import { Tag, Tooltip, message, type TableColumnsType } from "antd";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { useTranslation } from "react-i18next";
import { Zap, TrendingUp, Globe, AlertTriangle } from "lucide-react";
import "@/lib/i18n";

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
  const { t } = useTranslation();
  const [data, setData] = useState<PlatformUsage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    const fetchData = async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ period });
        const res = await fetch(`/api/admin/usage/platform?${params}`, {
          signal: controller.signal,
        });
        const json: Record<string, any> = await res.json();
        if (json.success && Array.isArray(json.data)) {
          setData(json.data);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        message.error(t("common.error"));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    fetchData();
    return () => controller.abort();
  }, [period, t, refreshKey]);

  // 汇总
  const summary = useMemo(
    () => ({
      totalRequests: data.reduce((s, p) => s + p.stats.totalRequests, 0),
      totalTokens: data.reduce((s, p) => s + p.stats.totalTokens, 0),
      activePlatforms: data.filter((p) => p.enabled).length,
      errorRequests: data.reduce((s, p) => s + p.stats.errorRequests, 0),
    }),
    [data]
  );

  const statCards = [
    {
      key: "requests",
      title: t("usage.total_requests"),
      value: summary.totalRequests,
      icon: <Zap />,
      bgColor: "bg-blue-50",
      iconColor: "text-blue-500",
    },
    {
      key: "tokens",
      title: t("usage.total_tokens"),
      value: summary.totalTokens,
      icon: <TrendingUp />,
      bgColor: "bg-emerald-50",
      iconColor: "text-emerald-500",
    },
    {
      key: "activePlatforms",
      title: t("dashboard.active_platforms"),
      value: summary.activePlatforms,
      suffix: `/ ${data.length}`,
      icon: <Globe />,
      bgColor: "bg-purple-50",
      iconColor: "text-purple-500",
    },
    {
      key: "errors",
      title: t("common.error") || "错误",
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

  const columns: TableColumnsType<PlatformUsage> = [
    {
      title: t("platform.name") || "平台名称",
      dataIndex: "name",
      key: "name",
      width: 150,
      ellipsis: true,
    },
    {
      title: t("platform.type") || "类型",
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
      title: t("usage.status"),
      dataIndex: "status",
      key: "status",
      width: 90,
      align: "center",
      render: (v: string) => (
        <Tag color={statusColorMap[v] || "default"}>{v}</Tag>
      ),
    },
    {
      title: t("usage.total_requests"),
      key: "totalRequests",
      width: 100,
      align: "right",
      render: (_: unknown, record: PlatformUsage) =>
        record.stats.totalRequests.toLocaleString(),
    },
    {
      title: t("usage.total_tokens"),
      key: "totalTokens",
      width: 110,
      align: "right",
      render: (_: unknown, record: PlatformUsage) =>
        record.stats.totalTokens.toLocaleString(),
    },
    {
      title: (
        <Tooltip title={t("usage.prompt_tokens_desc")}>
          {t("usage.prompt_tokens")}
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
        <Tooltip title={t("usage.completion_tokens_desc")}>
          {t("usage.completion_tokens")}
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
      title: t("common.error") || "错误",
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
        <Tooltip title={t("usage.avg_ttft_desc")}>
          {t("usage.avg_ttft")}
        </Tooltip>
      ),
      key: "avgTtft",
      width: 100,
      align: "right",
      render: (_: unknown, record: PlatformUsage) =>
        record.stats.avgTtft > 0 ? `${record.stats.avgTtft}ms` : "-",
      responsive: ["lg"],
    },
    {
      title: (
        <Tooltip title={t("usage.avg_tokens_per_sec_desc")}>
          {t("usage.avg_tokens_per_sec")}
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
        <Tooltip title={t("usage.avg_rpm_desc")}>
          {t("usage.avg_rpm")}
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
      title: t("usage.avg_duration"),
      key: "avgDuration",
      width: 100,
      align: "right",
      render: (_: unknown, record: PlatformUsage) =>
        record.stats.avgDuration > 0
          ? `${record.stats.avgDuration}ms`
          : "-",
      responsive: ["xl"],
    },
  ];

  return (
    <>
      {/* 统计卡片 */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
        {statCards.map((card) => (
          <div
            key={card.key}
            className="bg-white border border-zinc-200 rounded-xl p-4"
          >
            <div className="flex items-center gap-3">
              <div
                className={`h-9 w-9 ${card.bgColor} rounded-lg flex items-center justify-center`}
              >
                <span className={card.iconColor}>{card.icon}</span>
              </div>
              <div>
                <p className="text-zinc-500 text-xs">{card.title}</p>
                <p className="text-xl font-bold text-zinc-900">
                  {card.value.toLocaleString()}
                  {card.suffix && (
                    <span className="text-sm font-normal text-zinc-400 ml-1">
                      {card.suffix}
                    </span>
                  )}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* 明细表格 */}
      <ResponsiveTable
        columns={columns}
        dataSource={data}
        rowKey="id"
        loading={loading}
        pagination={{
          pageSize: 20,
          showTotal: (count) => t("common.pagination_total", { count }),
        }}
        scroll={{ x: 1200 }}
      />
    </>
  );
}
