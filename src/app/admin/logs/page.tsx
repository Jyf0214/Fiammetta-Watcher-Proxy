"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Tag,
  Select,
  message,
  type TableColumnsType,
} from "antd";
import { Button } from "@/components/ui/Button";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import { ReloadOutlined, FileTextOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import GlobalLoading from "@/components/Loading";

interface LogEntry {
  id: string;
  model: string;
  status: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  ttft: number;
  duration: number;
  isError: boolean;
  errorMessage: string | null;
  createdAt: string;
  key: { name: string } | null;
  platform: { name: string } | null;
}

export default function LogsPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [errorFilter, setErrorFilter] = useState<string>("");

  const fetchLogs = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: "20",
      });
      if (statusFilter) params.set("status", statusFilter);
      if (errorFilter) params.set("isError", errorFilter);

      const res = await fetch(`/api/admin/logs?${params}`, { signal });
      if (res.status === 401) {
        message.warning(t("auth.unauthorized") || "登录已过期，请重新登录");
        router.push("/admin/login");
        return;
      }
      const data = await res.json();
      if (data.success) {
        if (data.data?.items) setLogs(data.data.items);
        if (data.data) setTotal(data.data.total);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      message.error(t("common.error"));
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, [page, statusFilter, errorFilter, router, t]);

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchLogs(controller.signal);
    return () => controller.abort();
  }, [fetchLogs]);

  const columns: TableColumnsType<LogEntry> = [
    {
      title: t("common.created_at"),
      dataIndex: "createdAt",
      key: "createdAt",
      width: 170,
      render: (v: string) => new Date(v).toLocaleString(),
      responsive: ["sm"],
    },
    {
      title: t("log.api_key"),
      key: "keyName",
      width: 140,
      render: (_: unknown, record: LogEntry) => record.key?.name || "-",
    },
    {
      title: t("log.platform"),
      key: "platformName",
      width: 120,
      render: (_: unknown, record: LogEntry) => record.platform?.name || "-",
      responsive: ["md"],
    },
    {
      title: t("log.model"),
      dataIndex: "model",
      key: "model",
      ellipsis: true,
    },
    {
      title: t("log.status_code"),
      dataIndex: "status",
      key: "status",
      width: 90,
      align: "center",
      render: (v: number) => (
        <Tag color={v >= 200 && v < 300 ? "green" : v >= 400 ? "red" : "orange"}>
          {v}
        </Tag>
      ),
    },
    {
      title: t("log.tokens"),
      dataIndex: "tokens",
      key: "tokens",
      width: 100,
      align: "right",
      render: (v: number) => v.toLocaleString(),
      responsive: ["lg"],
    },
    {
      title: t("log.prompt_tokens"),
      dataIndex: "promptTokens",
      key: "promptTokens",
      width: 100,
      align: "right",
      render: (v: number) => v.toLocaleString(),
      responsive: ["xl"],
    },
    {
      title: t("log.completion_tokens"),
      dataIndex: "completionTokens",
      key: "completionTokens",
      width: 100,
      align: "right",
      render: (v: number) => v.toLocaleString(),
      responsive: ["xl"],
    },
    {
      title: t("log.ttft"),
      dataIndex: "ttft",
      key: "ttft",
      width: 90,
      align: "right",
      render: (v: number) => (v > 0 ? `${v}ms` : "-"),
      responsive: ["xl"],
    },
    {
      title: t("log.duration"),
      dataIndex: "duration",
      key: "duration",
      width: 90,
      align: "right",
      responsive: ["lg"],
      render: (v: number) => `${v}ms`,
    },
    {
      title: t("log.is_error"),
      dataIndex: "isError",
      key: "isError",
      width: 90,
      align: "center",
      render: (v: boolean) => (
        <Tag color={v ? "red" : "green"}>
          {v ? t("log.filter_error_only") : t("log.filter_normal_only")}
        </Tag>
      ),
    },
  ];

  if (loading && logs.length === 0) {
    return <GlobalLoading size="large" />;
  }

  return (
    <PageContainer>
      <PageHeader
        icon={<FileTextOutlined size={20} className="text-zinc-500 dark:text-zinc-400" />}
        title={t("admin.logs")}
        description={t("admin.logs_desc")}
        extra={
          <Button variant="default" icon={<ReloadOutlined />} onClick={() => fetchLogs()} disabled={loading}>
            {t("common.refresh")}
          </Button>
        }
      />

      <ProCard>
        <div className="mb-4 flex flex-wrap gap-2">
          <Select
            placeholder={t("log.status_filter_placeholder")}
            allowClear
            className="w-36"
            onChange={(v) => { setStatusFilter(v); setPage(1); }}
          >
            <Select.Option value="200">200</Select.Option>
            <Select.Option value="400">400</Select.Option>
            <Select.Option value="401">401</Select.Option>
            <Select.Option value="429">429</Select.Option>
            <Select.Option value="500">500</Select.Option>
            <Select.Option value="503">503</Select.Option>
          </Select>
          <Select
            placeholder={t("log.error_filter_placeholder")}
            allowClear
            className="w-36"
            onChange={(v) => { setErrorFilter(v); setPage(1); }}
          >
            <Select.Option value="true">
              {t("log.filter_error_only")}
            </Select.Option>
            <Select.Option value="false">
              {t("log.filter_normal_only")}
            </Select.Option>
          </Select>
        </div>

        <ResponsiveTable
          columns={columns}
          dataSource={logs}
          rowKey="id"
          loading={loading}
          pagination={{
            current: page,
            total,
            pageSize: 20,
            onChange: setPage,
            showTotal: (count) => t("common.pagination_total", { count }),
          }}
        />
      </ProCard>
    </PageContainer>
  );
}
