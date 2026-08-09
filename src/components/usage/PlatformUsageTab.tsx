import { useState, useEffect, useMemo } from "react";
import { Tag, Tooltip, message, type TableColumnsType } from "antd";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { ProCard } from "@/components/ui/ProCard";
import { formatDuration, formatCompactNumber, valueFontSize } from "@/lib/format";
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
  const { t } = useTranslation("usage");
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
        message.error(t("common:error"));
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
      title: t("totalRequests"),
      value: summary.totalRequests,
      icon: <Zap />,
      bgColor: "bg-blue-50",
      iconColor: "text-blue-500",
    },
    {
      key: "tokens",
      title: t("totalTokens"),
      value: summary.totalTokens,
      icon: <TrendingUp />,
      bgColor: "bg-emerald-50",
      iconColor: "text-emerald-500",
    },
    {
      key: "activePlatforms",
      title: t("dashboard:activePlatforms"),
      value: summary.activePlatforms,
      suffix: `/ ${data.length}`,
      icon: <Globe />,
      bgColor: "bg-purple-50",
      iconColor: "text-purple-500",
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
        <Tag color={statusColorMap[v] || "default"}>{v}</Tag>
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
        dataSource={data}
        rowKey="id"
        loading={loading}
        pagination={{
          pageSize: 20,
          showTotal: (count) => t("common:pagination", { count }),
        }}
        scroll={{ x: 1200 }}
      />
    </>
  );
}
