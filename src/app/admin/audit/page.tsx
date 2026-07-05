"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Card, Tag, message, type TableColumnsType } from "antd";
import { Button } from "@/components/ui/Button";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { RefreshCw } from "lucide-react";
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
  const router = useRouter();
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  // 修复：将 fetchLogs 提取为独立函数，供 useEffect 和按钮 onClick 共用
  const fetchLogs = async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/audit?page=${page}&pageSize=20`, { signal });
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
      console.error("获取审计日志失败:", err);
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
    fetchLogs(controller.signal);
    return () => controller.abort();
  }, [page]);

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
      width: 170,
      render: (v: string) => new Date(v).toLocaleString(),
    },
    {
      title: t("audit.admin"),
      key: "admin",
      width: 120,
      render: (_: unknown, record: AuditEntry) =>
        record.admin?.username || "-",
    },
    {
      title: t("common.action"),
      dataIndex: "action",
      key: "action",
      width: 180,
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
      width: 140,
      responsive: ["lg"],
    },
  ];

  if (loading && logs.length === 0) {
    return <GlobalLoading size="large" />;
  }

  return (
    <div>
      <div className="border-b border-zinc-100 dark:border-zinc-800 pb-4 mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
          {t("admin.audit")}
        </h1>
        <p className="text-zinc-500 dark:text-zinc-400 mt-1">
          {t("admin.audit_desc")}
        </p>
      </div>

      <Card className="rounded-2xl shadow-sm border border-zinc-100 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-4 flex justify-end">
          <Button variant="default" onClick={() => fetchLogs()} icon={<RefreshCw size={14} />} disabled={loading}>
            {t("common.refresh") || "刷新"}
          </Button>
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
          aria-label={t("admin.audit")}
        />
      </Card>
    </div>
  );
}
