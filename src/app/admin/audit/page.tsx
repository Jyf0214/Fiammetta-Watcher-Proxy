"use client";

import { useState, useEffect } from "react";
import { Table, Tag, message, type TableColumnsType } from "antd";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import GlobalLoading from "@/components/Loading";

interface AuditEntry {
  id: string;
  action: string;
  detail: string | null;
  ip: string | null;
  createdAt: string;
  admin: { username: string } | null;
}

export default function AuditPage() {
  const { t } = useTranslation();
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    fetchLogs();
  }, [page]);

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/audit?page=${page}&pageSize=20`);
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

  const actionColorMap: Record<string, string> = {
    login: "blue",
    logout: "default",
    create_platform: "green",
    update_platform: "orange",
    delete_platform: "red",
    create_api_key: "green",
    delete_api_key: "red",
    create_model_map: "green",
  };

  const columns: TableColumnsType<AuditEntry> = [
    {
      title: t("common.created_at"),
      dataIndex: "createdAt",
      key: "createdAt",
      width: 160,
      render: (v: string) => new Date(v).toLocaleString(),
    },
    {
      title: t("audit.admin"),
      key: "admin",
      render: (_: unknown, record: AuditEntry) => record.admin?.username || "-",
    },
    {
      title: t("common.action"),
      dataIndex: "action",
      key: "action",
      render: (v: string) => (
        <Tag color={actionColorMap[v] || "default"}>{v}</Tag>
      ),
    },
    {
      title: t("common.detail"),
      dataIndex: "detail",
      key: "detail",
      ellipsis: true,
      responsive: ["md"],
    },
    {
      title: "IP",
      dataIndex: "ip",
      key: "ip",
      responsive: ["lg"],
    },
  ];

  if (loading && logs.length === 0) {
    return <GlobalLoading size="large" />;
  }

  return (
    <div>
      <h3 className="mb-4">{t("admin.audit")}</h3>
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
        />
      </div>
    </div>
  );
}
