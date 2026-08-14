import { useState } from "react";
import { Tag, Popconfirm, Modal, Form, Input, InputNumber, Select, Alert, message } from "antd";
import { Plus, Trash2, Copy, Key, Pencil } from "lucide-react";
import { Button } from "@/components/ui/Button";
import Switch from "@/components/ui/Switch";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { AsyncBoundary } from "@/components/ui/AsyncBoundary";
import { EmptyState } from "@/components/ui/EmptyState";
import { ImperativeModal, createModal } from "@/components/ui/ImperativeModal";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { formatDateTime, formatDate } from "@/lib/timezone";
import { useApi } from "@/hooks/use-api";
import AdminLayout from "@/components/AdminLayout";

interface ApiKeyItem {
  id: string;
  key: string;
  name: string;
  usedTokens: number;
  tokenLimit: number | null;
  callLimit: number | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
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
  const { t } = useTranslation("apikey");
  const statusColor = apiKey.status === "active" ? "green" : apiKey.status === "disabled" ? "red" : "orange";
  const isActive = apiKey.status === "active";
  const statusText = apiKey.status === "active" ? t("statusActive") : apiKey.status === "disabled" ? t("statusDisabled") : t("statusExpired");

  const createdDate = formatDate(apiKey.createdAt);

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
      {/* 卡片头部：名称 + 状态标签 + 启用开关 */}
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">{apiKey.name}</h3>
          <Tag color={statusColor} className="!text-[10px] !px-1.5 !py-0 !m-0 shrink-0">{statusText}</Tag>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Switch checked={isActive} loading={togglingId === apiKey.id} onChange={() => onToggle(apiKey)} />
        </div>
      </div>

      {/* 卡片主体：Label-Value 排版 */}
      <div className="px-4 pb-2 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-zinc-400 w-14 shrink-0">{t("key")}</span>
          <span className="text-[11px] text-zinc-600 dark:text-zinc-300 font-mono truncate whitespace-nowrap overflow-hidden text-ellipsis">
            {apiKey.key}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-zinc-400 w-14 shrink-0">{t("common:createdAt")}</span>
          <span className="text-[11px] text-zinc-600 dark:text-zinc-300">{createdDate}</span>
        </div>
      </div>

      {/* 卡片底部操作栏 */}
      <div className="flex border-t border-zinc-100 dark:border-zinc-800">
        <button
          onClick={() => onEdit(apiKey)}
          className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs text-zinc-500 hover:text-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
        >
          <Pencil size={13} /> {t("common:edit")}
        </button>
        <div className="w-px bg-zinc-100 dark:bg-zinc-800" />
        <Popconfirm title={t("common:confirmDelete")} onConfirm={() => onDelete(apiKey.id)} okText={t("common:confirm")} cancelText={t("common:cancel")}>
          <button className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs text-zinc-500 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
            <Trash2 size={13} /> {t("common:delete")}
          </button>
        </Popconfirm>
      </div>
    </div>
  );
}

export default function KeysPage() {
  const { t } = useTranslation("apikey");
  /** 构建期内联的部署平台（Cloudflare / EdgeOne / Vercel / 空=自托管或本地） */
  const deployPlatform = process.env.NEXT_PUBLIC_DEPLOY_PLATFORM || "";
  // 数据层：SWR 缓存 + 统一 fetcher（401 由 fetcher 统一提示并跳转登录页）
  const { data: keys, isLoading, isValidating, mutate } = useApi<ApiKeyItem[]>("/api/admin/keys");
  const [modalOpen, setModalOpen] = useState(false);
  const [editItem, setEditItem] = useState<ApiKeyItem | null>(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [keyModal] = useState(() =>
    createModal({ title: t("createdTitle"), width: 520, content: null })
  );

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
        message.success(newStatus === "active" ? t("statusActive") : t("statusDisabled"));
        mutate();
      } else {
        message.error(data.error?.message || t("common:operationFailed"));
      }
    } catch {
      message.error(t("common:error"));
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
      // 预填真实限额（usedTokens 是已用量，误填会覆盖限额配置）
      tokenLimit: item.tokenLimit,
      callLimit: item.callLimit,
      rpmLimit: item.rpmLimit,
      tpmLimit: item.tpmLimit,
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
          message.success(t("updateSuccess"));
          setModalOpen(false);
          mutate();
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
          const keyValue = data.data.key as string;
          keyModal.update({
            title: t("createdTitle"),
            onCancel: () => keyModal.close(),
            content: (
              <>
                <p className="text-zinc-400 dark:text-zinc-300 mb-3">{t("saveWarning")}</p>
                <div className="bg-zinc-800 dark:bg-zinc-700 p-3 rounded-lg font-mono text-sm break-all text-zinc-200 dark:text-zinc-100 border border-zinc-700 dark:border-zinc-600">
                  {keyValue}
                </div>
                <Button
                  variant="default"
                  className="mt-3 w-full sm:w-auto"
                  icon={<Copy size={14} />}
                  aria-label={t("copyKey")}
                  onClick={() => copyToClipboard(keyValue)}
                >
                  {t("copyKey")}
                </Button>
              </>
            ),
          });
          keyModal.open();
          mutate();
        } else {
          message.error(data.error?.message);
        }
      }
    } catch (err) {
      if (!("errorFields" in (err as Record<string, unknown>))) message.error(t("common:error"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/keys/${id}`, { method: "DELETE" });
      const data: Record<string, any> = await res.json();
      if (data.success) {
        message.success(t("deleteSuccess"));
        mutate();
      } else {
        message.error(data.error?.message || t("common:error"));
      }
    } catch {
      message.error(t("common:error"));
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success(t("common:copied"));
    } catch {
      message.error(t("common:copyFailed"));
    }
  };

  // 桌面端表格列（保持表格模式）
  const columns = [
    {
      title: t("name"),
      dataIndex: "name",
      key: "name",
      width: 140,
      ellipsis: true,
    },
    {
      title: t("key"),
      dataIndex: "key",
      key: "key",
      ellipsis: true,
      render: (v: string) => (
        <span className="font-mono text-xs whitespace-nowrap overflow-hidden text-ellipsis">{v}</span>
      ),
    },
    {
      title: t("usedTokens"),
      dataIndex: "usedTokens",
      key: "usedTokens",
      width: 120,
      align: "right" as const,
      render: (v: number) => v.toLocaleString(),
      responsive: ["md" as const],
    },
    {
      title: t("common:status"),
      dataIndex: "status",
      key: "status",
      width: 100,
      align: "center" as const,
      render: (v: string) => {
        const colorMap: Record<string, string> = { active: "green", disabled: "red", expired: "orange" };
        const textMap: Record<string, string> = {
          active: t("statusActive"),
          disabled: t("statusDisabled"),
          expired: t("statusExpired"),
        };
        return <Tag color={colorMap[v] || "default"}>{textMap[v] || v}</Tag>;
      },
    },
    {
      title: t("common:createdAt"),
      dataIndex: "createdAt",
      key: "createdAt",
      width: 180,
      render: (v: string) => formatDateTime(v),
      responsive: ["lg" as const],
    },
    {
      title: t("common:actions"),
      dataIndex: "actions",
      key: "actions",
      width: 140,
      align: "center" as const,
      render: (_: unknown, item: ApiKeyItem) => (
        <div className="flex items-center justify-center gap-1">
          <button
            type="button"
            onClick={() => openEdit(item)}
            title={t("common:edit")}
            className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
          >
            <Pencil size={14} />
          </button>
          <button
            type="button"
            onClick={() => copyToClipboard(item.key)}
            title={t("copyKey")}
            className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
          >
            <Copy size={14} />
          </button>
          <Popconfirm title={t("common:confirmDelete")} onConfirm={() => handleDelete(item.id)} okText={t("common:confirm")} cancelText={t("common:cancel")}>
            <button
              type="button"
              title={t("common:delete")}
              className="p-1.5 rounded-md text-zinc-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
            >
              <Trash2 size={14} />
            </button>
          </Popconfirm>
        </div>
      ),
    },
  ];

  if (isLoading && !keys) {
    return (
      <AdminLayout>
        <PageContainer>
          <AsyncBoundary isLoading error={null}>
            <></>
          </AsyncBoundary>
        </PageContainer>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout>
      <PageContainer>
        <PageHeader
          icon={<Key size={20} className="text-zinc-500 dark:text-zinc-400" />}
          title={t("admin:keys")}
          description={t("admin:keysDesc")}
          extra={
            <Button variant="primary" icon={<Plus size={14} />} onClick={openCreate}>
              {t("createKey")}
            </Button>
          }
        />

        <Alert
          type="info"
          showIcon
          message={
            deployPlatform === "cf"
              ? t("baseUrlCfHint")
              : t("baseUrlSelfHint")
          }
          className="mb-3"
        />

        {/* 移动端：卡片列表 */}
        <div className="sm:hidden space-y-3 mb-6">
          {(keys ?? []).length === 0 && !isValidating ? (
            <EmptyState title={t("noApiKey")} />
          ) : (
            (keys ?? []).map((apiKey) => (
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
              dataSource={keys ?? []}
              rowKey="id"
              loading={isValidating}
              pagination={{
                pageSize: 20,
                showTotal: (total) => t("common:pagination", { count: total }),
              }}
              scroll={{ x: 700 }}
            />
          </ProCard>
        </div>

        {/* 创建/编辑弹窗 */}
        <Modal
          title={editItem ? t("editKey") : t("createKey")}
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
            <Form.Item name="name" label={t("name")} rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="tokenLimit" label={t("tokenLimit")}>
              <InputNumber min={0} className="w-full" placeholder={t("common:unlimited")} />
            </Form.Item>
            <Form.Item name="callLimit" label={t("callLimit")}>
              <InputNumber min={0} className="w-full" placeholder={t("common:unlimited")} />
            </Form.Item>
            <Form.Item name="rpmLimit" label={t("rpmLimit")}>
              <InputNumber min={0} className="w-full" placeholder={t("common:unlimited")} />
            </Form.Item>
            <Form.Item name="tpmLimit" label={t("tpmLimit")}>
              <InputNumber min={0} className="w-full" placeholder={t("common:unlimited")} />
            </Form.Item>
            <Form.Item name="resetPeriod" label={t("resetPeriod")} initialValue="monthly">
              <Select
                options={[
                  { value: "monthly", label: t("resetMonthly") },
                  { value: "daily", label: t("resetDaily") },
                  { value: "never", label: t("resetNever") },
                ]}
              />
            </Form.Item>
          </Form>
        </Modal>

        {/* 命令式密钥展示弹窗 */}
        <ImperativeModal instance={keyModal} />
      </PageContainer>
    </AdminLayout>
  );
}
