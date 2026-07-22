import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";
import { Tag, toast } from "@lobehub/ui";
import type { TableColumnsType } from "antd";
import { Button } from "@/components/ui/Button";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import { RefreshCw, History } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import GlobalLoading from "@/components/Loading";
import AdminLayout from "@/components/AdminLayout";

interface AuditEntry {
  id: string;
  action: string;
  detail: string | null;
  ip: string | null;
  createdAt: string;
  admin: { username: string } | null;
}

function AuditContent() {
  const { t } = useTranslation();
  const router = useRouter();
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    const fetchLogs = async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/admin/audit?page=${page}&pageSize=20`, { signal: controller.signal });
        if (res.status === 401) {
          toast.warning(t("auth.unauthorized") || "登录已过期，请重新登录");
          router.push("/admin/login");
          return;
        }
        const data: any = await res.json();
        if (data.success) {
          if (data.data?.items) setLogs(data.data.items);
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

    fetchLogs();
    return () => controller.abort();
  }, [page, router, t, refreshKey]);

  const handleRefresh = useCallback(() => {
    setRefreshKey(k => k + 1);
  }, []);

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
    <PageContainer>
      <PageHeader
        icon={<History size={20} className="text-zinc-500 dark:text-zinc-400" />}
        title={t("admin.audit")}
        description={t("admin.audit_desc")}
        extra={
          <Button variant="default" onClick={handleRefresh} icon={<RefreshCw size={14} />} disabled={loading}>
            {t("common.refresh") || "刷新"}
          </Button>
        }
      />

      <ProCard>
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

// ==================== 带 AdminLayout 包装的页面 ====================

export default function AuditPage() {
  return (
    <AdminLayout>
      <AuditContent />
    </AdminLayout>
  );
}
