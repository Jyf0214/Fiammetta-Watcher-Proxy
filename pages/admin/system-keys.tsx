/**
 * 系统 API Key 管理页
 *
 * 管理用于后台 API 认证的系统级 Key（Authorization: Bearer）。
 * 与 v1 代理 Key 完全隔离。
 */

import { useState, useEffect } from "react";
import { Popconfirm, Modal, Form, Input, Switch, Spin, Alert, message, type TableColumnsType } from "antd";
import { Plus, Trash2, Copy, Shield, Key } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import { AsyncBoundary } from "@/components/ui/AsyncBoundary";
import { ImperativeModal, createModal } from "@/components/ui/ImperativeModal";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { formatDateTime } from "@/lib/timezone";
import { copyToClipboard as writeClipboard } from "@/lib/ui";
import { useApi, UNAUTHORIZED_MESSAGE } from "@/hooks/use-api";
import AdminLayout from "@/components/AdminLayout";

interface SystemKeyItem {
  id: string;
  key: string;
  name: string;
  enabled: boolean;
  lastUsedAt: number | null;
  createdAt: number;
}

export default function SystemKeysPage() {
  const { t } = useTranslation("system");

  // 数据层：SWR 缓存 + 统一 fetcher（401 由 fetcher 统一提示并跳转登录页）
  // 服务端分页：带 limit/offset 时后端返回 { total, items }（接口约定 A12）
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(1);
  const {
    data: keysData,
    error,
    isLoading,
    mutate,
  } = useApi<{ total: number; items: SystemKeyItem[] }>(
    `/api/admin/system-keys?limit=${PAGE_SIZE}&offset=${(page - 1) * PAGE_SIZE}`
  );
  const keys = keysData?.items ?? [];
  const total = keysData?.total ?? 0;

  // 请求失败提示
  useEffect(() => {
    if (error && error.message !== UNAUTHORIZED_MESSAGE) {
      message.error(t("common:error"));
    }
  }, [error, t]);

  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [keyModal] = useState(() =>
    createModal({
      title: t("sysKeyCreatedTitle"),
      width: 520,
      okText: t("sysKeySaved"),
      content: null,
    })
  );

  const handleCreate = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const res = await fetch("/api/admin/system-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const data: Record<string, any> = await res.json();
      if (data.success) {
        message.success(data.message || t("sysKeyCreateSuccess"));
        setModalOpen(false);
        form.resetFields();
        const keyValue = data.data.key as string;
        keyModal.update({
          title: t("sysKeyCreatedTitle"),
          okText: t("sysKeySaved"),
          onCancel: () => keyModal.close(),
          onOk: () => keyModal.close(),
          content: (
            <>
              <Alert type="warning" message={t("sysKeyShowOnce")} className="mb-3" />
              <div className="bg-neutral-50 dark:bg-neutral-800 rounded p-3 font-mono text-sm break-all">
                {keyValue}
              </div>
              <Button
                className="mt-3"
                onClick={() => copyToClipboard(keyValue)}
                icon={<Copy size={14} />}
              >
                {t("sysKeyCopy")}
              </Button>
            </>
          ),
        });
        keyModal.open();
        mutate();
      } else {
        message.error(data.error || t("sysKeyCreateFailed"));
      }
    } catch (err) {
      // 表单校验失败（errorFields）静默：字段红框已提示；网络等真实错误必须可见，
      // 否则用户以为没点中反复提交（与 keys.tsx handleSubmit 同模式）
      if (!("errorFields" in (err as Record<string, unknown>))) message.error(t("common:error"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/system-keys/${id}`, { method: "DELETE" });
      const data: Record<string, any> = await res.json();
      if (data.success) {
        message.success(t("sysKeyDeleteSuccess"));
        // 删除当前页最后一条时回退一页，避免停留在空页
        if (keys.length === 1 && page > 1) setPage(page - 1);
        mutate();
      } else {
        message.error(data.error || t("sysKeyDeleteFailed"));
      }
    } catch {
      message.error(t("sysKeyDeleteFailed"));
    }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    // loading 防重：请求期间 Switch 转圈且不可重复触发（与 keys.tsx togglingId 同模式）
    setTogglingId(id);
    try {
      const res = await fetch(`/api/admin/system-keys/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data: Record<string, any> = await res.json();
      if (data.success) {
        message.success(enabled ? t("sysKeyToggleEnabled") : t("sysKeyToggleDisabled"));
        mutate();
      } else {
        message.error(data.error || t("sysKeyOperationFailed"));
      }
    } catch {
      message.error(t("sysKeyOperationFailed"));
    } finally {
      setTogglingId(null);
    }
  };

  // 剪贴板写入统一走共享工具：navigator.clipboard 在 HTTP 环境为 undefined，
  // 直接 .then() 会同步抛 TypeError 且无 catch 捕获（表现为死按钮），降级路径在此收口
  const copyToClipboard = async (text: string) => {
    const ok = await writeClipboard(text);
    if (ok) {
      message.success(t("sysKeyCopied"));
    } else {
      message.error(t("sysKeyCopyFailed"));
    }
  };

  // 列表接口只返回脱敏掩码，复制前先经 GET /api/admin/system-keys/[id] 取完整密钥
  const copySystemKey = async (item: SystemKeyItem) => {
    setCopyingId(item.id);
    try {
      const res = await fetch(`/api/admin/system-keys/${item.id}`);
      const data: Record<string, any> = await res.json();
      if (data.success && typeof data.key === "string") {
        copyToClipboard(data.key);
      } else {
        message.error(t("sysKeyCopyFailed"));
      }
    } catch {
      message.error(t("sysKeyCopyFailed"));
    } finally {
      setCopyingId(null);
    }
  };

  const formatTime = (ts: number | null) => {
    if (!ts) return "—";
    return formatDateTime(ts);
  };

  const columns: TableColumnsType<SystemKeyItem> = [
    { title: t("common:name"), dataIndex: "name", key: "name", width: 200 },
    {
      title: t("apikey:key"),
      dataIndex: "key",
      key: "key",
      width: 220,
      render: (key: string, record: SystemKeyItem) => (
        <div className="flex items-center gap-1 min-w-0">
          <code className="flex-1 min-w-0 truncate text-xs bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 rounded">
            {key}
          </code>
          <button
            onClick={() => copySystemKey(record)}
            disabled={copyingId === record.id}
            className="p-1 rounded text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
            title={t("common:copy")}
          >
            {copyingId === record.id ? <Spin size="small" /> : <Copy size={13} />}
          </button>
        </div>
      ),
    },
    {
      title: t("common:status"),
      dataIndex: "enabled",
      key: "enabled",
      width: 120,
      render: (enabled: boolean, record) => (
        <div className="flex items-center gap-2">
          <Switch
            checked={enabled}
            size="small"
            loading={togglingId === record.id}
            onChange={(checked) => handleToggle(record.id, checked)}
          />
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            {enabled ? t("sysKeyToggleEnabled") : t("sysKeyToggleDisabled")}
          </span>
        </div>
      ),
    },
    { title: t("sysKeyLastUsed"), dataIndex: "lastUsedAt", key: "lastUsedAt", width: 180, render: (v: number | null) => formatTime(v) },
    { title: t("common:createdAt"), dataIndex: "createdAt", key: "createdAt", width: 180, render: (v: number) => formatTime(v) },
    {
      title: t("common:actions"),
      key: "actions",
      width: 80,
      render: (_, record) => (
        <Popconfirm title={t("sysKeyDeleteConfirm")} onConfirm={() => handleDelete(record.id)} okText={t("common:delete")} cancelText={t("common:cancel")}>
          <Button variant="dangerGhost" size="sm">
            <Trash2 size={14} />
          </Button>
        </Popconfirm>
      ),
    },
  ];

  if (isLoading && !keysData) {
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
          title={t("sysKeyTitle")}
          description={t("sysKeyDesc")}
          extra={
            <Button variant="primary" onClick={() => setModalOpen(true)} icon={<Plus size={16} />}>
              {t("sysKeyCreate")}
            </Button>
          }
        />

        <Alert
          type="warning"
          showIcon
          message={t("sysKeyAlert")}
          className="mb-3"
        />

        <ProCard>
          <ResponsiveTable
            columns={columns}
            dataSource={keys ?? []}
            rowKey="id"
            pagination={{
              current: page,
              pageSize: PAGE_SIZE,
              total,
              onChange: setPage,
              showTotal: (total) => t("common:pagination", { count: total }),
            }}
          />
        </ProCard>

        {/* 创建弹窗 */}
        <Modal
          title={t("sysKeyModalTitle")}
          open={modalOpen}
          onOk={handleCreate}
          onCancel={() => { setModalOpen(false); form.resetFields(); }}
          confirmLoading={submitting}
          okText={t("sysKeyCreateBtn")}
          cancelText={t("common:cancel")}
        >
          <Form form={form} layout="vertical" autoComplete="off">
            <Form.Item
              name="name"
              label={t("sysKeyNameLabel")}
              rules={[{ required: true, message: t("sysKeyNameRequired") }, { max: 100, message: t("sysKeyNameMax") }]}
            >
              <Input placeholder={t("sysKeyNamePlaceholder")} />
            </Form.Item>
          </Form>
          <div className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
            <Shield size={12} className="inline mr-1" />
            {t("sysKeyUsageHint")}
          </div>
        </Modal>

        {/* 命令式密钥展示弹窗 */}
        <ImperativeModal instance={keyModal} />
      </PageContainer>
    </AdminLayout>
  );
}
