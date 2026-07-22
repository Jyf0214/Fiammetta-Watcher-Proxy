import { useState, useEffect, useMemo } from "react";
import { Tag, Tooltip, toast } from "@lobehub/ui";
import type { TableColumnsType } from "antd";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { useTranslation } from "react-i18next";
import { Zap, TrendingUp, Cloud, Clock } from "lucide-react";
import "@/lib/i18n";

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
  const { t } = useTranslation();
  const [data, setData] = useState<KeyUsage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    const fetchData = async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ period });
        const res = await fetch(`/api/admin/usage?${params}`, {
          signal: controller.signal,
        });
        const json = await res.json();
        if (json.success && Array.isArray(json.data)) {
          setData(json.data);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        toast.error(t("common.error"));
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
      totalRequests: data.reduce((s, k) => s + k.stats.totalRequests, 0),
      totalTokens: data.reduce((s, k) => s + k.stats.totalTokens, 0),
      activeKeys: data.filter((k) => k.status === "active").length,
      avgTtft:
        data.length > 0
          ? Math.round(
              data.reduce((s, k) => s + k.stats.avgTtft, 0) / data.length
            )
          : 0,
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
      key: "activeKeys",
      title: t("usage.active_keys"),
      value: summary.activeKeys,
      suffix: `/ ${data.length}`,
      icon: <Cloud />,
      bgColor: "bg-purple-50",
      iconColor: "text-purple-500",
    },
    {
      key: "ttft",
      title: t("usage.avg_ttft"),
      value: summary.avgTtft,
      suffix: "ms",
      icon: <Clock />,
      bgColor: "bg-amber-50",
      iconColor: "text-amber-500",
    },
  ];

  const columns: TableColumnsType<KeyUsage> = [
    {
      title: t("usage.key_name"),
      dataIndex: "name",
      key: "name",
      width: 140,
      ellipsis: true,
    },
    {
      title: t("usage.key"),
      dataIndex: "key",
      key: "key",
      width: 160,
      render: (v: string) => (
        <span className="font-mono text-xs">{v}</span>
      ),
    },
    {
      title: t("usage.status"),
      dataIndex: "status",
      key: "status",
      width: 90,
      align: "center",
      render: (v: string) => (
        <Tag color={v === "active" ? "green" : "red"}>
          {v === "active" ? t("common.enable") : t("common.disable")}
        </Tag>
      ),
    },
    {
      title: t("usage.total_requests"),
      key: "totalRequests",
      width: 100,
      align: "right",
      render: (_: unknown, record: KeyUsage) =>
        record.stats.totalRequests.toLocaleString(),
    },
    {
      title: t("usage.total_tokens"),
      key: "totalTokens",
      width: 110,
      align: "right",
      render: (_: unknown, record: KeyUsage) =>
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
      render: (_: unknown, record: KeyUsage) =>
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
      render: (_: unknown, record: KeyUsage) =>
        record.stats.completionTokens.toLocaleString(),
      responsive: ["md"],
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
      render: (_: unknown, record: KeyUsage) =>
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
      render: (_: unknown, record: KeyUsage) =>
        record.stats.avgTokensPerSecond > 0
          ? record.stats.avgTokensPerSecond.toFixed(1)
          : "-",
      responsive: ["lg"],
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
      render: (_: unknown, record: KeyUsage) =>
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
      render: (_: unknown, record: KeyUsage) =>
        record.stats.avgDuration > 0
          ? `${record.stats.avgDuration}ms`
          : "-",
      responsive: ["xl"],
    },
    {
      title: t("usage.token_limit"),
      key: "tokenLimit",
      width: 100,
      align: "right",
      render: (_: unknown, record: KeyUsage) =>
        record.tokenLimit
          ? record.tokenLimit.toLocaleString()
          : t("common.unlimited"),
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
        scroll={{ x: 1400 }}
      />
    </>
  );
}
