"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Table, Card, Tag, message, type TableColumnsType } from "antd";
import { Button } from "@/components/ui/Button";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import GlobalLoading from "@/components/Loading";

interface EventEntry {
  id: string;
  level: string;
  message: string;
  detail: string | null;
  createdAt: string;
}

export default function EventsPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const [events, setEvents] = useState<EventEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  // 修复：将 fetchEvents 提取为独立函数，供 useEffect 和按钮 onClick 共用
  const fetchEvents = async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/admin/logs?type=events&page=${page}&pageSize=20`,
        { signal }
      );
      if (res.status === 401) {
        message.warning(t("auth.unauthorized") || "登录已过期，请重新登录");
        router.push("/admin/login");
        return;
      }
      const data = await res.json();
      if (data.success) {
        if (data.data?.items) setEvents(data.data.items);
        if (data.data) setTotal(data.data.total);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      console.error("获取系统事件失败:", err);
      message.error(t("common.error"));
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  };

  // 修复：添加 AbortController 防止组件卸载后的竞态请求
  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchEvents(controller.signal);
    return () => controller.abort();
  }, [page]);

  const levelColorMap: Record<string, string> = {
    info: "blue",
    warning: "orange",
    error: "red",
    critical: "magenta",
  };

  const columns: TableColumnsType<EventEntry> = [
    {
      title: t("common.created_at"),
      dataIndex: "createdAt",
      key: "createdAt",
      width: 170,
      render: (v: string) => new Date(v).toLocaleString(),
    },
    {
      title: t("event.level"),
      dataIndex: "level",
      key: "level",
      width: 100,
      align: "center",
      render: (v: string) => (
        <Tag color={levelColorMap[v] || "default"}>{v}</Tag>
      ),
    },
    {
      title: t("common.message"),
      dataIndex: "message",
      key: "message",
      ellipsis: true,
    },
    {
      title: t("common.detail"),
      dataIndex: "detail",
      key: "detail",
      ellipsis: true,
      responsive: ["md"],
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

  if (loading && events.length === 0) {
    return <GlobalLoading size="large" />;
  }

  return (
    <div>
      <div className="border-b border-zinc-100 dark:border-zinc-800 pb-4 mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
          {t("admin.events")}
        </h1>
        <p className="text-zinc-500 dark:text-zinc-400 mt-1">
          {t("admin.events_desc")}
        </p>
      </div>

      <Card className="rounded-2xl shadow-sm border border-zinc-100 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-4 flex justify-end">
          <Button variant="default" onClick={() => fetchEvents()} icon={<RefreshCw size={14} />} disabled={loading}>
            {t("common.refresh") || "刷新"}
          </Button>
        </div>
        <div className="overflow-x-auto">
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
              showTotal: (count) => t("common.pagination_total", { count }),
            }}
            aria-label={t("admin.events")}
          />
        </div>
      </Card>
    </div>
  );
}
