"use client";

import { useState, useEffect } from "react";
import { Table, Tag, message } from "antd";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";

interface EventEntry {
  id: string;
  level: string;
  message: string;
  detail: string | null;
  createdAt: string;
}

export default function EventsPage() {
  const { t } = useTranslation();
  const [events, setEvents] = useState<EventEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    fetchEvents();
  }, [page]);

  const fetchEvents = async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/admin/logs?type=events&page=${page}&pageSize=20`
      );
      const data = await res.json();
      if (data.success) {
        setEvents(data.data.items);
        setTotal(data.data.total);
      }
    } catch {
      message.error(t("common.error"));
    } finally {
      setLoading(false);
    }
  };

  const levelColorMap: Record<string, string> = {
    info: "blue",
    warning: "orange",
    error: "red",
    critical: "magenta",
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
      title: "级别",
      dataIndex: "level",
      key: "level",
      render: (v: string) => (
        <Tag color={levelColorMap[v] || "default"}>{v}</Tag>
      ),
    },
    { title: "消息", dataIndex: "message", key: "message" },
    {
      title: "详情",
      dataIndex: "detail",
      key: "detail",
      ellipsis: true,
      render: (v: string | null) => {
        if (!v) return "-";
        try {
          const parsed = JSON.parse(v);
          return parsed.content || v.substring(0, 100);
        } catch {
          return v.substring(0, 100);
        }
      },
    },
  ];

  return (
    <div>
      <h3 className="mb-4">{t("admin.events")}</h3>
      <Table
        columns={columns}
        dataSource={events}
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
