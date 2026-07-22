import { useState, useEffect, useCallback } from "react";
import { Space, Tag, Popconfirm, Tooltip, Modal, Form, Input, InputNumber, Select, message, type TableColumnsType } from "antd";
import { Plus, Trash2, Copy, Key } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
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

export default function KeysPage() {
  const { t } = useTranslation();
  const [keys, setKeys] = useState<ApiKeyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [newKeyVisible, setNewKeyVisible] = useState(false);
  const [newKeyValue, setNewKeyValue] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    const fetchKeys = async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/admin/keys", { signal: controller.signal });
        const data: Record<string, any> = await res.json();
        if (data.success && Array.isArray(data.data)) setKeys(data.data);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        message.error(t("common.error"));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };

    fetchKeys();
    return () => controller.abort();
  }, [t, refreshKey]);

  const handleRefresh = useCallback(() => {
    setRefreshKey(k => k + 1);
  }, []);

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);

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
        message.error(data.error);
      }
    } catch (err) {
      if (!('errorFields' in (err as Record<string, unknown>))) message.error(t("common.error"));
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
        message.error(data.error || t("common.error"));
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

  const statusColorMap: Record<string, string> = {
    active: "green",
    disabled: "red",
    expired: "orange",
  };

  const columns: TableColumnsType<ApiKeyItem> = [
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
        <Space size="small">
          <span className="font-mono text-xs">{v.substring(0, 16)}...</span>
          <Tooltip title={t("common.copy")}>
            <Button
              variant="ghost"
              size="sm"
              icon={<Copy size={14} />}
              iconOnly
              aria-label={t("common.copy")}
              onClick={() => copyToClipboard(v)}
            />
          </Tooltip>
        </Space>
      ),
    },
    {
      title: t("api_key.used_tokens"),
      dataIndex: "usedTokens",
      key: "usedTokens",
      width: 120,
      align: "right",
      render: (v: number) => v.toLocaleString(),
      responsive: ["md"],
    },
    {
      title: t("common.status"),
      dataIndex: "status",
      key: "status",
      width: 100,
      align: "center",
      render: (v: string) => (
        <Tag color={statusColorMap[v] || "default"}>{v}</Tag>
      ),
    },
    {
      title: t("common.created_at"),
      dataIndex: "createdAt",
      key: "createdAt",
      width: 180,
      render: (v: string) => new Date(v).toLocaleString(),
      responsive: ["lg"],
    },
    {
      title: t("common.actions"),
      key: "actions",
      fixed: "right",
      width: 80,
      align: "center",
      render: (_: unknown, record: ApiKeyItem) => (
        <Popconfirm
          title={t("common.confirm_delete")}
          onConfirm={() => handleDelete(record.id)}
        >
          <Button
            variant="dangerGhost"
            size="sm"
            icon={<Trash2 size={14} />}
            iconOnly
            aria-label={t("common.delete")}
          />
        </Popconfirm>
      ),
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
            <Button
              variant="primary"
              icon={<Plus size={14} />}
              onClick={() => {
                form.resetFields();
                setModalOpen(true);
              }}
            >
              {t("api_key.create_key")}
            </Button>
          }
        />

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

        <Modal
          title={t("api_key.create_key")}
          open={modalOpen}
          onCancel={() => {
            setModalOpen(false);
            form.resetFields();
          }}
          onOk={handleSubmit}
          confirmLoading={submitting}
          centered
          width={520}
          style={{ maxWidth: "90vw" }}
        >
          <Form form={form} layout="vertical">
            <Form.Item
              name="name"
              label={t("api_key.name")}
              rules={[{ required: true }]}
            >
              <Input />
            </Form.Item>
            <Form.Item name="tokenLimit" label={t("api_key.token_limit")}>
              <InputNumber
                min={0}
                className="w-full"
                placeholder={t("common.unlimited")}
              />
            </Form.Item>
            <Form.Item name="callLimit" label={t("api_key.call_limit")}>
              <InputNumber
                min={0}
                className="w-full"
                placeholder={t("common.unlimited")}
              />
            </Form.Item>
            <Form.Item name="rpmLimit" label={t("api_key.rpm_limit")}>
              <InputNumber
                min={0}
                className="w-full"
                placeholder={t("common.unlimited")}
              />
            </Form.Item>
            <Form.Item name="tpmLimit" label={t("api_key.tpm_limit")}>
              <InputNumber
                min={0}
                className="w-full"
                placeholder={t("common.unlimited")}
              />
            </Form.Item>
            <Form.Item
              name="resetPeriod"
              label={t("api_key.reset_period")}
              initialValue="monthly"
            >
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

        <Modal
          title={t("api_key.created_title")}
          open={newKeyVisible}
          onCancel={() => setNewKeyVisible(false)}
          centered
          width={520}
          style={{ maxWidth: "90vw" }}
          footer={[
            <Button
              key="close"
              variant="default"
              onClick={() => setNewKeyVisible(false)}
              className="w-full sm:w-auto"
            >
              {t("common.close")}
            </Button>,
          ]}
        >
          <p className="text-zinc-400 dark:text-zinc-300 mb-3">
            {t("api_key.save_warning")}
          </p>
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
