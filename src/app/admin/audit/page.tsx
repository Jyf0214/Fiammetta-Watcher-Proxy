"use client";

import { useState, useEffect } from "react";
import { Table, Tag, message } from "antd";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";

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

  const columns = [
    {
      title: t("common.created_at"),
      dataIndex: "createdAt",
      key: "createdAt",
      width: 180,
      render: (v: string) => new Date(v).toLocaleString(),
    },
    {
      title: "管理员",
      key: "admin",
      render: (_: unknown, record: AuditEntry) => record.admin?.username || "-",
    },
    {
      title: "操作",
      dataIndex: "action",
      key: "action",
      render: (v: string) => (
        <Tag color={actionColorMap[v] || "default"}>{v}</Tag>
      ),
    },
    { title: "详情", dataIndex: "detail", key: "detail", ellipsis: true },
    { title: "IP", dataIndex: "ip", key: "ip" },
  ];

  return (
    <div>
      <h3 className="mb-4">{t("admin.audit")}</h3>
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
  );
}
