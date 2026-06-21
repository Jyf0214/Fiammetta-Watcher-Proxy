"use client";

import { useState, useEffect } from "react";
import { Table, Tag, Select, Space, Button, message, type TableColumnsType } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";

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
      width: 160,
      render: (v: string) => new Date(v).toLocaleString(),
      responsive: ["sm"],
    },
    {
      title: t("log.api_key"),
      key: "keyName",
      render: (_: unknown, record: LogEntry) => record.key?.name || "-",
    },
    {
      title: t("log.platform"),
      key: "platformName",
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
      width: 80,
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
      render: (v: number) => v.toLocaleString(),
      responsive: ["lg"],
    },
    {
      title: t("log.duration"),
      dataIndex: "duration",
      key: "duration",
      responsive: ["lg"],
      render: (v: number) => `${v}ms`,
    },
    {
      title: t("log.is_error"),
      dataIndex: "isError",
      key: "isError",
      width: 80,
      render: (v: boolean) => (
        <Tag color={v ? "red" : "green"}>{v ? "错误" : "正常"}</Tag>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
        <h3 className="m-0">{t("admin.logs")}</h3>
        <div className="flex flex-wrap gap-2">
          <Select
            placeholder="状态码筛选"
            allowClear
            className="w-32"
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
            placeholder="错误筛选"
            allowClear
            className="w-32"
            onChange={(v) => setErrorFilter(v)}
          >
            <Select.Option value="true">仅错误</Select.Option>
            <Select.Option value="false">仅正常</Select.Option>
          </Select>
          <Button icon={<ReloadOutlined />} onClick={fetchLogs}>
            刷新
          </Button>
        </div>
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
            showTotal: (count) => `共 ${count} 条`,
          }}
        />
      </div>
    </div>
  );
}
