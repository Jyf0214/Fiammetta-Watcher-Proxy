"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Tag, toast } from "@lobehub/ui";
import type { TableColumnsType } from "antd"; // @lobehub/ui 没有 TableColumnsType 类型，保留 antd
import { Button } from "@/components/ui/Button";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import { RefreshCw, AlertTriangle } from "lucide-react";
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
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    const fetchEvents = async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/admin/logs?type=events&page=${page}&pageSize=20`,
          { signal: controller.signal }
        );
        if (res.status === 401) {
          toast.warning(t("auth.unauthorized") || "登录已过期，请重新登录");
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
        toast.error(t("common.error"));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };

    fetchEvents();
    return () => controller.abort();
  }, [page, router, t, refreshKey]);

  const handleRefresh = useCallback(() => {
    setRefreshKey(k => k + 1);
  }, []);

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
    <PageContainer>
      <PageHeader
        icon={<AlertTriangle size={20} className="text-zinc-500 dark:text-zinc-400" />}
        title={t("admin.events")}
        description={t("admin.events_desc")}
        extra={
          <Button variant="default" onClick={handleRefresh} icon={<RefreshCw size={14} />} disabled={loading}>
            {t("common.refresh") || "刷新"}
          </Button>
        }
      />

      <ProCard>
        <ResponsiveTable
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
        />
      </ProCard>
    </PageContainer>
  );
}
