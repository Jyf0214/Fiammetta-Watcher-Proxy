import { useState, useEffect, useCallback } from "react";
import { Tag, message, type TableColumnsType } from "antd";
import { Button } from "@/components/ui/Button";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { RefreshCw, History } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { formatDateTime } from "@/lib/timezone";
import { useApi, UNAUTHORIZED_MESSAGE } from "@/hooks/use-api";
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

// ==================== 操作名称 i18n 键映射 ====================

const ACTION_LABELS: Record<string, string> = {
  login: "actionLogin",
  logout: "actionLogout",
  create_platform: "actionCreatePlatform",
  update_platform: "actionUpdatePlatform",
  delete_platform: "actionDeletePlatform",
  create_api_key: "actionCreateApiKey",
  delete_api_key: "actionDeleteApiKey",
  create_model_map: "actionCreateModelMap",
  update_model_map: "actionUpdateModelMap",
  delete_model_map: "actionDeleteModelMap",
  enable_model_map: "actionEnableModelMap",
  disable_model_map: "actionDisableModelMap",
  batch_enable_model_maps: "actionBatchEnableModelMaps",
  batch_disable_model_maps: "actionBatchDisableModelMaps",
  batch_delete_model_maps: "actionBatchDeleteModelMaps",
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
    return <GlobalLoading size="large" />;
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
