import { useState, useEffect, useCallback } from "react";
import { Tag, message, type TableColumnsType } from "antd";
import { Button } from "@/components/ui/Button";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { AsyncBoundary } from "@/components/ui/AsyncBoundary";
import { RefreshCw, History } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { formatDateTime } from "@/lib/timezone";
import { useApi, UNAUTHORIZED_MESSAGE } from "@/hooks/use-api";
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

// ==================== 操作名称 i18n 键映射 ====================

const ACTION_LABELS: Record<string, string> = {
  login: "actionLogin",
  login_success: "actionLogin",
  login_failed: "actionLoginFailed",
  logout: "actionLogout",
  create_platform: "actionCreatePlatform",
  update_platform: "actionUpdatePlatform",
  delete_platform: "actionDeletePlatform",
  create_api_key: "actionCreateApiKey",
  update_api_key: "actionUpdateApiKey",
  delete_api_key: "actionDeleteApiKey",
  toggle_platform_key: "actionTogglePlatformKey",
  create_system_key: "actionCreateSystemKey",
  delete_system_key: "actionDeleteSystemKey",
  import_data: "actionImportData",
  export_data: "actionExportData",
};

// ==================== 语义颜色映射 ====================

const ACTION_COLOR: Record<string, string> = {
  login: "blue",
  login_success: "blue",
  login_failed: "red",
  logout: "default",
  create_platform: "green",
  update_platform: "orange",
  delete_platform: "red",
  create_api_key: "green",
  update_api_key: "orange",
  delete_api_key: "red",
  toggle_platform_key: "orange",
  create_system_key: "green",
  delete_system_key: "red",
  import_data: "purple",
  export_data: "purple",
};

// ==================== 页面组件 ====================

function AuditContent() {
  const { t } = useTranslation("audit");
  const [page, setPage] = useState(1);

  // 审计日志：key 含分页参数，翻页时 SWR 自动重新请求
  const auditKey = `/api/admin/audit?page=${page}&pageSize=20`;
  const { data, error, isLoading, isValidating, mutate } = useApi<{
    items: AuditEntry[];
    total: number;
  }>(auditKey);

  // 请求失败提示（401 已由 fetcher 统一提示并跳转登录页）
  useEffect(() => {
    if (error && error.message !== UNAUTHORIZED_MESSAGE) {
      message.error(t("common:error"));
    }
  }, [error, t]);

  const handleRefresh = useCallback(() => {
    mutate();
  }, [mutate]);

  /** 获取操作名称的 i18n 标签 */
  const getActionLabel = (action: string): string => {
    const key = ACTION_LABELS[action];
    return t(key ?? action);
  };

  const columns: TableColumnsType<AuditEntry> = [
    {
      title: t("common:action"),
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
      title: t("admin"),
      dataIndex: "username",
      key: "username",
      width: 120,
      render: (v: string | null) => v || "-",
    },
    {
      title: t("common:detail"),
      dataIndex: "detail",
      key: "detail",
      ellipsis: true,
      // 移动端恒显：detail 是审计记录的核心内容（做了什么），不能按断点砍掉
    },
    {
      title: t("ip"),
      dataIndex: "ip",
      key: "ip",
      width: 140,
      responsive: ["lg"],
    },
    {
      title: t("common:createdAt"),
      dataIndex: "createdAt",
      key: "createdAt",
      width: 170,
      render: (v: string) => formatDateTime(v),
    },
  ];

  if (isLoading && !data) {
    return (
      <PageContainer>
        <AsyncBoundary isLoading error={null}>
          <></>
        </AsyncBoundary>
      </PageContainer>
    );
  }

  if (error && !data) {
    return (
      <PageContainer>
        <AsyncBoundary isLoading={false} error={error} onRetry={mutate}>
          <></>
        </AsyncBoundary>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        icon={<History size={20} className="text-zinc-500 dark:text-zinc-400" />}
        title={t("admin:audit")}
        description={t("admin:auditDesc")}
        extra={
          <Button variant="default" onClick={handleRefresh} icon={<RefreshCw size={14} />} disabled={isValidating}>
            {t("common:refresh")}
          </Button>
        }
      />

      <ResponsiveTable
        columns={columns}
        dataSource={data?.items ?? []}
        rowKey="id"
        loading={isValidating}
        pagination={{
          current: page,
          total: data?.total ?? 0,
          pageSize: 20,
          onChange: setPage,
          showTotal: (count) => t("common:pagination", { count }),
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
