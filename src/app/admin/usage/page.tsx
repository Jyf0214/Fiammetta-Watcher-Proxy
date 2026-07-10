"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Select,
  Tag,
  Tooltip,
  Statistic,
  message,
  type TableColumnsType,
} from "antd";
import { Button } from "@/components/ui/Button";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import { ReloadOutlined, BarChartOutlined, ThunderboltOutlined, FieldTimeOutlined, CloudServerOutlined, RiseOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import GlobalLoading from "@/components/Loading";
import dynamic from "next/dynamic";

const Line = dynamic(() => import("@ant-design/charts").then((mod) => mod.Line), {
  ssr: false,
  loading: () => <div className="h-[320px] bg-zinc-50 dark:bg-zinc-800/50 rounded-xl animate-pulse" />,
});

// ==================== 类型定义 ====================

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

interface TrendPoint {
  date: string;
  requests: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
}

// ==================== 页面组件 ====================

export default function UsagePage() {
  const { t } = useTranslation();
  const [usageData, setUsageData] = useState<KeyUsage[]>([]);
  const [trendData, setTrendData] = useState<TrendPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [trendLoading, setTrendLoading] = useState(true);
  const [period, setPeriod] = useState<string>("month");
  const [refreshKey, setRefreshKey] = useState(0);

  // 获取用量数据
  useEffect(() => {
    const controller = new AbortController();

    const fetchUsage = async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ period });
        const res = await fetch(`/api/admin/usage?${params}`, { signal: controller.signal });
        const data = await res.json();
        if (data.success && Array.isArray(data.data)) {
          setUsageData(data.data);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        message.error(t("common.error"));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    fetchUsage();
    return () => controller.abort();
  }, [period, t, refreshKey]);

  // 获取趋势数据
  useEffect(() => {
    const controller = new AbortController();

    const fetchTrend = async () => {
      setTrendLoading(true);
      try {
        const params = new URLSearchParams({ period });
        const res = await fetch(`/api/admin/usage/trend?${params}`, { signal: controller.signal });
        const data = await res.json();
        if (data.success && Array.isArray(data.data)) {
          setTrendData(data.data);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
      } finally {
        if (!controller.signal.aborted) setTrendLoading(false);
      }
    };

    fetchTrend();
    return () => controller.abort();
  }, [period, t, refreshKey]);

  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  // 汇总统计
  const summary = useMemo(() => {
    const totalRequests = usageData.reduce((s, k) => s + k.stats.totalRequests, 0);
    const totalTokens = usageData.reduce((s, k) => s + k.stats.totalTokens, 0);
    const activeKeys = usageData.filter((k) => k.status === "active").length;
    const avgTtft = usageData.length > 0
      ? Math.round(usageData.reduce((s, k) => s + k.stats.avgTtft, 0) / usageData.length)
      : 0;
    return { totalRequests, totalTokens, activeKeys, avgTtft };
  }, [usageData]);

  // 折线图配置
  const chartData = useMemo(() => {
    const points: Array<{ date: string; type: string; value: number }> = [];
    for (const d of trendData) {
      points.push({ date: d.date, type: t("usage.requests") || "请求数", value: d.requests });
      points.push({ date: d.date, type: t("usage.total_tokens") || "Token", value: d.tokens });
    }
    return points;
  }, [trendData, t]);

  const chartConfig = useMemo(() => ({
    data: chartData,
    xField: "date",
    yField: "value",
    colorField: "type",
    height: 320,
    axis: {
      x: { labelAutoRotate: true },
      y: { title: "" },
    },
    legend: { position: "top" as const },
    interaction: { tooltip: { render: (_e: unknown, { title, items }: { title: string; items: Array<{ name: string; value: number; color: string }> }) => {
      if (!items || items.length === 0) return "";
      let html = `<div style="font-weight:500;margin-bottom:4px">${title}</div>`;
      for (const item of items) {
        html += `<div style="display:flex;align-items:center;gap:6px;margin:2px 0">
          <span style="width:8px;height:8px;border-radius:50%;background:${item.color};display:inline-block"></span>
          <span>${item.name}:</span>
          <span style="font-weight:500">${item.value.toLocaleString()}</span>
        </div>`;
      }
      return html;
    }} },
    style: { lineWidth: 2 },
  }), [chartData]);

  // ==================== 表格列 ====================

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
        record.stats.avgDuration > 0 ? `${record.stats.avgDuration}ms` : "-",
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

  if (loading && usageData.length === 0) {
    return <GlobalLoading size="large" />;
  }

  return (
    <PageContainer>
      <PageHeader
        icon={<BarChartOutlined size={20} className="text-zinc-500 dark:text-zinc-400" />}
        title={t("admin.usage")}
        description={t("admin.usage_desc")}
        extra={
          <div className="flex gap-2">
            <Select
              value={period}
              onChange={setPeriod}
              className="w-32"
              options={[
                { value: "all", label: t("usage.period_all") },
                { value: "today", label: t("usage.period_today") },
                { value: "week", label: t("usage.period_week") },
                { value: "month", label: t("usage.period_month") },
              ]}
            />
            <Button
              variant="default"
              icon={<ReloadOutlined />}
              onClick={handleRefresh}
              disabled={loading}
            >
              {t("common.refresh")}
            </Button>
          </div>
        }
      />

      {/* 汇总统计卡片 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        <ProCard>
          <Statistic
            title={t("usage.total_requests")}
            value={summary.totalRequests}
            prefix={<ThunderboltOutlined className="text-blue-500" />}
            loading={loading}
          />
        </ProCard>
        <ProCard>
          <Statistic
            title={t("usage.total_tokens")}
            value={summary.totalTokens}
            prefix={<RiseOutlined className="text-green-500" />}
            groupSeparator=","
            loading={loading}
          />
        </ProCard>
        <ProCard>
          <Statistic
            title={t("usage.active_keys")}
            value={summary.activeKeys}
            suffix={`/ ${usageData.length}`}
            prefix={<CloudServerOutlined className="text-purple-500" />}
            loading={loading}
          />
        </ProCard>
        <ProCard>
          <Statistic
            title={t("usage.avg_ttft")}
            value={summary.avgTtft}
            suffix="ms"
            prefix={<FieldTimeOutlined className="text-orange-500" />}
            loading={loading}
          />
        </ProCard>
      </div>

      {/* 趋势折线图 */}
      <ProCard
        title={t("usage.trend_title") || "请求与 Token 趋势"}
        className="mb-4"
      >
        {trendLoading ? (
          <div className="h-[320px] flex items-center justify-center">
            <GlobalLoading size="small" />
          </div>
        ) : trendData.length === 0 ? (
          <div className="h-[320px] flex items-center justify-center text-zinc-400">
            {t("common.no_data") || "暂无数据"}
          </div>
        ) : (
          <Line {...chartConfig} />
        )}
      </ProCard>

      {/* 详细用量表格 */}
      <ProCard
        title={t("usage.detail_title") || "Key 用量明细"}
        extra={
          <span className="text-sm text-zinc-500 dark:text-zinc-400">
            {t("common.total")}: {usageData.length}
          </span>
        }
      >
        <ResponsiveTable
          columns={columns}
          dataSource={usageData}
          rowKey="id"
          loading={loading}
          pagination={{
            pageSize: 20,
            showTotal: (count) => t("common.pagination_total", { count }),
          }}
          scroll={{ x: 1400 }}
        />
      </ProCard>
    </PageContainer>
  );
}
