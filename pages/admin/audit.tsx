import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";
import { Tag, message, type TableColumnsType } from "antd";
import { Button } from "@/components/ui/Button";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { RefreshCw, History } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { formatDateTime } from "@/lib/timezone";
import GlobalLoading from "@/components/Loading";
import AdminLayout from "@/components/AdminLayout";

// ==================== 类型 ====================

interface AuditEntry {
  id: string;
  action: string;
  detail: string | null;
  ip: string | null;
  createdAt: string;
  username: string | null;
}

// ==================== 操作名称中英双语翻译 ====================

const ACTION_LABELS: Record<string, { zh: string; en: string }> = {
  login: { zh: "管理员登录", en: "Admin Login" },
  logout: { zh: "管理员登出", en: "Admin Logout" },
  create_platform: { zh: "创建平台", en: "Create Platform" },
  update_platform: { zh: "更新平台", en: "Update Platform" },
  delete_platform: { zh: "删除平台", en: "Delete Platform" },
  create_api_key: { zh: "创建 API Key", en: "Create API Key" },
  delete_api_key: { zh: "删除 API Key", en: "Delete API Key" },
  create_model_map: { zh: "创建模型映射", en: "Create Model Map" },
  update_model_map: { zh: "更新模型映射", en: "Update Model Map" },
  delete_model_map: { zh: "删除模型映射", en: "Delete Model Map" },
  enable_model_map: { zh: "启用模型映射", en: "Enable Model Map" },
  disable_model_map: { zh: "禁用模型映射", en: "Disable Model Map" },
  batch_enable_model_maps: { zh: "批量启用模型映射", en: "Batch Enable Model Maps" },
  batch_disable_model_maps: { zh: "批量禁用模型映射", en: "Batch Disable Model Maps" },
  batch_delete_model_maps: { zh: "批量删除模型映射", en: "Batch Delete Model Maps" },
};

// ==================== 语义颜色映射 ====================

const ACTION_COLOR: Record<string, string> = {
  login: "blue",
  logout: "default",
  create_platform: "green",
  update_platform: "orange",
  delete_platform: "red",
  create_api_key: "green",
  delete_api_key: "red",
  create_model_map: "green",
  update_model_map: "orange",
  delete_model_map: "red",
  enable_model_map: "green",
  disable_model_map: "gold",
  batch_enable_model_maps: "green",
  batch_disable_model_maps: "gold",
  batch_delete_model_maps: "red",
};

// ==================== 页面组件 ====================

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
          message.warning(t("auth.unauthorized") || "登录已过期，请重新登录");
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
        message.error(t("common.error"));
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
    setRefreshKey((k) => k + 1);
  }, []);

  /** 获取操作的中英双语标签 */
  const getActionLabel = (action: string): string => {
    const label = ACTION_LABELS[action];
    if (!label) return action;
    const isZh = t("audit.admin") === "管理员";
    return isZh ? label.zh : label.en;
  };

  const columns: TableColumnsType<AuditEntry> = [
    {
      title: t("common.action"),
      dataIndex: "action",
      key: "action",
      width: 180,
      render: (v: string) => (
        <Tag color={ACTION_COLOR[v] || "default"}>
          {getActionLabel(v)}
        </Tag>
      ),
    },
    {
      title: t("audit.admin"),
      dataIndex: "username",
      key: "username",
      width: 120,
      render: (v: string | null) => v || "-",
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
    {
      title: t("common.created_at"),
      dataIndex: "createdAt",
      key: "createdAt",
      width: 170,
      render: (v: string) => formatDateTime(v),
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
