import { useState, useEffect, useCallback } from "react";
import { Tag, Popconfirm, Tooltip, Modal, Form, Input, InputNumber, Select, message } from "antd";
import { Plus, Trash2, Copy, Key, Pencil } from "lucide-react";
import { Button } from "@/components/ui/Button";
import Switch from "@/components/ui/Switch";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import GlobalLoading from "@/components/Loading";
import AdminLayout from "@/components/AdminLayout";

interface ApiKeyItem {
  id: string;
  key: string;
  name: string;
  planId: string | null;
  usedTokens: number;
  status: string;
  resetPeriod: string;
  expiresAt: string | null;
  createdAt: string;
}

/** 移动端 API Key 卡片 — 与平台管理风格统一 */
function ApiKeyCard({
  apiKey,
  togglingId,
  onToggle,
  onEdit,
  onDelete,
}: {
  apiKey: ApiKeyItem;
  togglingId: string | null;
  onToggle: (item: ApiKeyItem) => void;
  onEdit: (item: ApiKeyItem) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  const statusColor = apiKey.status === "active" ? "green" : apiKey.status === "disabled" ? "red" : "orange";
  const isActive = apiKey.status === "active";

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success(t("common.copied"));
    } catch {
      message.error(t("common.copy_failed") || "复制失败");
    }
  };

  const createdDate = new Date(apiKey.createdAt).toLocaleDateString();

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
      {/* 卡片头部：名称 + 状态标签 + 启用开关 */}
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">{apiKey.name}</h3>
          <Tag color={statusColor} className="!text-[10px] !px-1.5 !py-0 !m-0 shrink-0">{apiKey.status}</Tag>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-zinc-400">{isActive ? t("common.enable") : t("common.disable")}</span>
          <Switch checked={isActive} loading={togglingId === apiKey.id} onChange={() => onToggle(apiKey)} />
        </div>
      </div>

      {/* 卡片主体：Label-Value 排版 */}
      <div className="px-4 pb-2 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-zinc-400 w-14 shrink-0">API Key</span>
          <div className="flex items-center gap-1 min-w-0 flex-1">
            <span className="text-[11px] text-zinc-600 dark:text-zinc-300 font-mono truncate whitespace-nowrap overflow-hidden text-ellipsis">
              {apiKey.key}
            </span>
            <Tooltip title={t("common.copy")}>
              <button
                onClick={() => copyToClipboard(apiKey.key)}
                className="shrink-0 p-0.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
              >
                <Copy size={12} />
              </button>
            </Tooltip>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-zinc-400 w-14 shrink-0">创建时间</span>
          <span className="text-[11px] text-zinc-600 dark:text-zinc-300">{createdDate}</span>
        </div>
      </div>

      {/* 卡片底部操作栏 */}
      <div className="flex border-t border-zinc-100 dark:border-zinc-800">
        <button
          onClick={() => copyToClipboard(apiKey.key)}
          className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs text-zinc-500 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
        >
          <Copy size={13} /> 复制 Key
        </button>
        <div className="w-px bg-zinc-100 dark:bg-zinc-800" />
        <button
          onClick={() => onEdit(apiKey)}
          className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs text-zinc-500 hover:text-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
        >
          <Pencil size={13} /> 编辑
        </button>
        <div className="w-px bg-zinc-100 dark:border-zinc-800" />
        <Popconfirm title={t("common.confirm_delete")} onConfirm={() => onDelete(apiKey.id)} okText={t("common.confirm")} cancelText={t("common.cancel")}>
          <button className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs text-zinc-500 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
            <Trash2 size={13} /> 删除
          </button>
        </Popconfirm>
      </div>
    </div>
  );
}

export default function KeysPage() {
  const { t } = useTranslation();
  const [keys, setKeys] = useState<ApiKeyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editItem, setEditItem] = useState<ApiKeyItem | null>(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [newKeyVisible, setNewKeyVisible] = useState(false);
  const [newKeyValue, setNewKeyValue] = useState("");
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleRefresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/admin/keys", { signal: controller.signal })
      .then((res) => res.json())
      .then((data: Record<string, any>) => {
        if (data.success && Array.isArray(data.data)) setKeys(data.data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [refreshKey]);

  const handleRefresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const handleToggle = async (item: ApiKeyItem) => {
    const newStatus = item.status === "active" ? "disabled" : "active";
    setTogglingId(item.id);
    try {
      const res = await fetch(`/api/admin/keys/${item.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      const data: Record<string, any> = await res.json();
      if (data.success) {
        message.success(newStatus === "active" ? "已启用" : "已禁用");
        handleRefresh();
      } else {
        message.error(data.error?.message || "操作失败");
      }
    } catch {
      message.error(t("common.error"));
    } finally {
      setTogglingId(null);
    }
  };

  const openCreate = () => {
    setEditItem(null);
    form.resetFields();
    setModalOpen(true);
  };

  const openEdit = (item: ApiKeyItem) => {
    setEditItem(item);
    form.setFieldsValue({
      name: item.name,
      tokenLimit: item.usedTokens,
      resetPeriod: item.resetPeriod,
    });
    setModalOpen(true);
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);

      if (editItem) {
        const res = await fetch(`/api/admin/keys/${editItem.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values),
        });
        const data: Record<string, any> = await res.json();
        if (data.success) {
          message.success("更新成功");
          setModalOpen(false);
          handleRefresh();
        } else {
          message.error(data.error?.message);
        }
      } else {
        const res = await fetch("/api/admin/keys", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values),
        });
        const data: Record<string, any> = await res.json();
        if (data.success) {
          message.success(data.message);
          setModalOpen(false);
          form.resetFields();
          setNewKeyValue(data.data.key);
          setNewKeyVisible(true);
          handleRefresh();
        } else {
          message.error(data.error?.message);
        }
      }
    } catch (err) {
      if (!("errorFields" in (err as Record<string, unknown>))) message.error(t("common.error"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/keys/${id}`, { method: "DELETE" });
      const data: Record<string, any> = await res.json();
      if (data.success) {
        message.success(t("api_key.delete_success") || "删除成功");
        handleRefresh();
      } else {
        message.error(data.error?.message || t("common.error"));
      }
    } catch {
      message.error(t("common.error"));
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success(t("common.copied"));
    } catch {
      message.error(t("common.copy_failed") || "复制失败");
    }
  };

  // 桌面端表格列（保持表格模式）
  const columns = [
    {
      title: t("api_key.name"),
      dataIndex: "name",
      key: "name",
      width: 140,
      ellipsis: true,
    },
    {
      title: t("api_key.key"),
      dataIndex: "key",
      key: "key",
      ellipsis: true,
      render: (v: string) => (
        <div className="flex items-center gap-1">
          <span className="font-mono text-xs whitespace-nowrap overflow-hidden text-ellipsis">{v}</span>
          <Tooltip title={t("common.copy")}>
            <button
              onClick={() => copyToClipboard(v)}
              className="shrink-0 p-0.5 text-zinc-400 hover:text-zinc-600 transition-colors"
            >
              <Copy size={12} />
            </button>
          </Tooltip>
        </div>
      ),
    },
    {
      title: t("api_key.used_tokens"),
      dataIndex: "usedTokens",
      key: "usedTokens",
      width: 120,
      align: "right" as const,
      render: (v: number) => v.toLocaleString(),
      responsive: ["md" as const],
    },
    {
      title: t("common.status"),
      dataIndex: "status",
      key: "status",
      width: 100,
      align: "center" as const,
      render: (v: string) => {
        const colorMap: Record<string, string> = { active: "green", disabled: "red", expired: "orange" };
        return <Tag color={colorMap[v] || "default"}>{v}</Tag>;
      },
    },
    {
      title: t("common.created_at"),
      dataIndex: "createdAt",
      key: "createdAt",
      width: 180,
      render: (v: string) => new Date(v).toLocaleString(),
      responsive: ["lg" as const],
    },
  ];

  if (loading && keys.length === 0) {
    return <GlobalLoading size="large" />;
  }

  return (
    <AdminLayout>
      <PageContainer>
        <PageHeader
          icon={<Key size={20} className="text-zinc-500 dark:text-zinc-400" />}
          title={t("admin.keys")}
          description={t("admin.keys_desc")}
          extra={
            <Button variant="primary" icon={<Plus size={14} />} onClick={openCreate}>
              {t("api_key.create_key")}
            </Button>
          }
        />

        {/* 移动端：卡片列表 */}
        <div className="sm:hidden space-y-3 mb-6">
          {keys.length === 0 && !loading ? (
            <div className="text-center py-12 text-sm text-zinc-400">暂无 API Key</div>
          ) : (
            keys.map((apiKey) => (
              <ApiKeyCard
                key={apiKey.id}
                apiKey={apiKey}
                togglingId={togglingId}
                onToggle={handleToggle}
                onEdit={openEdit}
                onDelete={handleDelete}
              />
            ))
          )}
        </div>

        {/* 桌面端：表格 */}
        <div className="hidden sm:block">
          <ProCard>
            <ResponsiveTable
              columns={columns}
              dataSource={keys}
              rowKey="id"
              loading={loading}
              pagination={{
                pageSize: 20,
                showTotal: (total) => t("common.pagination_total", { count: total }),
              }}
              scroll={{ x: 700 }}
            />
          </ProCard>
        </div>

        {/* 创建/编辑弹窗 */}
        <Modal
          title={editItem ? "编辑 API Key" : t("api_key.create_key")}
          open={modalOpen}
          onCancel={() => {
            setModalOpen(false);
            setEditItem(null);
            form.resetFields();
          }}
          onOk={handleSubmit}
          confirmLoading={submitting}
          centered
          width={520}
          style={{ maxWidth: "90vw" }}
        >
          <Form form={form} layout="vertical">
            <Form.Item name="name" label={t("api_key.name")} rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="tokenLimit" label={t("api_key.token_limit")}>
              <InputNumber min={0} className="w-full" placeholder={t("common.unlimited")} />
            </Form.Item>
            <Form.Item name="callLimit" label={t("api_key.call_limit")}>
              <InputNumber min={0} className="w-full" placeholder={t("common.unlimited")} />
            </Form.Item>
            <Form.Item name="rpmLimit" label={t("api_key.rpm_limit")}>
              <InputNumber min={0} className="w-full" placeholder={t("common.unlimited")} />
            </Form.Item>
            <Form.Item name="tpmLimit" label={t("api_key.tpm_limit")}>
              <InputNumber min={0} className="w-full" placeholder={t("common.unlimited")} />
            </Form.Item>
            <Form.Item name="resetPeriod" label={t("api_key.reset_period")} initialValue="monthly">
              <Select
                options={[
                  { value: "monthly", label: t("api_key.reset_monthly") },
                  { value: "daily", label: t("api_key.reset_daily") },
                  { value: "never", label: t("api_key.reset_never") },
                ]}
              />
            </Form.Item>
          </Form>
        </Modal>

        {/* 新 Key 展示弹窗 */}
        <Modal
          title={t("api_key.created_title")}
          open={newKeyVisible}
          onCancel={() => setNewKeyVisible(false)}
          centered
          width={520}
          style={{ maxWidth: "90vw" }}
          footer={[
            <Button key="close" variant="default" onClick={() => setNewKeyVisible(false)} className="w-full sm:w-auto">
              {t("common.close")}
            </Button>,
          ]}
        >
          <p className="text-zinc-400 dark:text-zinc-300 mb-3">{t("api_key.save_warning")}</p>
          <div className="bg-zinc-800 dark:bg-zinc-700 p-3 rounded-lg font-mono text-sm break-all text-zinc-200 dark:text-zinc-100 border border-zinc-700 dark:border-zinc-600">
            {newKeyValue}
          </div>
          <Button
            variant="default"
            className="mt-3 w-full sm:w-auto"
            icon={<Copy size={14} />}
            aria-label={t("api_key.copy_key")}
            onClick={() => copyToClipboard(newKeyValue)}
          >
            {t("api_key.copy_key")}
          </Button>
        </Modal>
      </PageContainer>
    </AdminLayout>
  );
}
