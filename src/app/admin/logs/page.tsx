"use client";

import { useState, useEffect } from "react";
import {
  Table,
  Card,
  Tag,
  Select,
  Button,
  message,
  type TableColumnsType,
} from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import GlobalLoading from "@/components/Loading";

interface LogEntry {
  id: string;
  model: string;
  status: number;
  tokens: number;
  duration: number;
  isError: boolean;
  errorMessage: string | null;
  createdAt: string;
  key: { name: string } | null;
  platform: { name: string } | null;
}

export default function LogsPage() {
  const { t } = useTranslation();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [errorFilter, setErrorFilter] = useState<boolean | undefined>();

  useEffect(() => {
    fetchLogs();
  }, [page, statusFilter, errorFilter]);

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: "20",
      });
      if (statusFilter) params.set("status", statusFilter);
      if (errorFilter !== undefined) params.set("isError", String(errorFilter));

      const res = await fetch(`/api/admin/logs?${params}`);
      const data = await res.json();
      if (data.success) {
        setLogs(data.data.items);
        setTotal(data.data.total);
      }
    } catch {
      message.error(t("common.error"));
    } finally {
      setLoading(false);
    }
  };

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
    <div>
      <div className="border-b border-zinc-100 dark:border-zinc-800 pb-4 mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
          {t("admin.logs")}
        </h1>
        <p className="text-zinc-500 dark:text-zinc-400 mt-1">
          {t("admin.logs_desc")}
        </p>
      </div>

      <Card className="rounded-2xl shadow-sm border border-zinc-100 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
          <div className="flex flex-wrap gap-2">
            <Select
              placeholder={t("log.status_filter_placeholder")}
              allowClear
              className="w-36"
              onChange={(v) => setStatusFilter(v)}
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
              onChange={(v) => setErrorFilter(v)}
            >
              <Select.Option value="true">
                {t("log.filter_error_only")}
              </Select.Option>
              <Select.Option value="false">
                {t("log.filter_normal_only")}
              </Select.Option>
            </Select>
          </div>
          <Button icon={<ReloadOutlined />} aria-label={t("common.refresh")} onClick={fetchLogs}>
            {t("common.refresh")}
          </Button>
        </div>

        <div className="overflow-x-auto">
          <Table
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
            aria-label={t("admin.logs")}
          />
        </div>
      </Card>
    </div>
  );
}
