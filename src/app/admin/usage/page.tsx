"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Select,
  Tag,
  Tooltip,
  message,
  type TableColumnsType,
} from "antd";
import { Button } from "@/components/ui/Button";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import { ReloadOutlined, BarChartOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import GlobalLoading from "@/components/Loading";

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

export default function UsagePage() {
  const { t } = useTranslation();
  const [usageData, setUsageData] = useState<KeyUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<string>("all");
  const [refreshKey, setRefreshKey] = useState(0);

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
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };

    fetchUsage();
    return () => controller.abort();
  }, [period, t, refreshKey]);

  const handleRefresh = useCallback(() => {
    setRefreshKey(k => k + 1);
  }, []);

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
        record.tokenLimit ? record.tokenLimit.toLocaleString() : t("common.unlimited"),
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
          <Button
            variant="default"
            icon={<ReloadOutlined />}
            onClick={handleRefresh}
            disabled={loading}
          >
            {t("common.refresh")}
          </Button>
        }
      />

      <ProCard
        extra={
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
