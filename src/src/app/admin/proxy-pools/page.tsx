"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Tag,
  Modal,
  Form,
  Input,
  toast,
} from "@lobehub/ui";
import {
  Popconfirm,
  type TableColumnsType,
} from "antd";
import { Button } from "@/components/ui/Button";
import Switch from "@/components/ui/Switch";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import { Plus, Trash2, Pencil, RefreshCw, Database } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import GlobalLoading from "@/components/Loading";

interface PoolItem {
  id: string;
  name: string;
  enabled: boolean;
  proxyCount: number;
  createdAt: string;
  updatedAt: string;
}

export default function ProxyPoolsPage() {
  const { t } = useTranslation();
  const [pools, setPools] = useState<PoolItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<PoolItem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    const controller = new AbortController();

    const fetchPools = async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/admin/pools", { signal: controller.signal });
        if (res.status === 401) return;
        const data = await res.json();
        if (data.success && Array.isArray(data.data)) setPools(data.data);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        toast.error(t("common.error"));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    fetchPools();
    return () => controller.abort();
  }, [t, refreshKey]);

  const handleRefresh = useCallback(() => {
    setRefreshKey(k => k + 1);
  }, []);

  const openCreateForm = () => {
    setEditing(null);
    form.resetFields();
    setModalOpen(true);
  };

  const openEditForm = (pool: PoolItem) => {
    setEditing(pool);
    form.setFieldsValue({ name: pool.name });
    setModalOpen(true);
  };

  const closeForm = () => {
    setModalOpen(false);
    setEditing(null);
    form.resetFields();
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);

      if (editing) {
        const res = await fetch(`/api/admin/pools/${editing.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values),
        });
        const data = await res.json();
        if (data.success) {
          toast.success(t("proxy_pool.edit_success") || "更新成功");
          closeForm();
          handleRefresh();
        } else {
          toast.error(data.error || t("common.error"));
        }
      } else {
        const res = await fetch("/api/admin/pools", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values),
        });
        const data = await res.json();
        if (data.success) {
          toast.success(t("proxy_pool.create_success") || "创建成功");
          closeForm();
          handleRefresh();
        } else {
          toast.error(data.error || t("common.error"));
        }
      }
    } catch (err) {
      if (err && typeof err === "object" && "errorFields" in err) return;
      toast.error(t("common.error"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/pools/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        toast.success(t("proxy_pool.delete_success") || "删除成功");
        handleRefresh();
      } else {
        toast.error(data.error || t("common.error"));
      }
    } catch {
      toast.error(t("common.error"));
    }
  };

  const handleToggle = async (pool: PoolItem) => {
    try {
      const res = await fetch(`/api/admin/pools/${pool.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !pool.enabled }),
      });
      const data = await res.json();
      if (data.success) handleRefresh();
      else toast.error(data.error || t("common.error"));
    } catch {
      toast.error(t("common.error"));
    }
  };

  const columns: TableColumnsType<PoolItem> = [
    {
      title: t("proxy_pool.name"),
      dataIndex: "name",
      key: "name",
      width: 200,
    },
    {
      title: t("proxy_pool.proxy_count"),
      dataIndex: "proxyCount",
      key: "proxyCount",
      width: 100,
      align: "center",
      render: (v: number) => <Tag>{v}</Tag>,
    },
    {
      title: t("common.status"),
      key: "enabled",
      width: 100,
      align: "center",
      render: (_: unknown, record: PoolItem) => (
        <Switch
          checked={record.enabled}
          onChange={() => handleToggle(record)}
          checkedChildren={t("common.enable")}
          unCheckedChildren={t("common.disable")}
        />
      ),
    },
    {
      title: t("common.actions"),
      key: "actions",
      fixed: "right",
      width: 120,
      align: "center",
      render: (_: unknown, record: PoolItem) => (
        <div className="flex items-center justify-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<Pencil />}
            onClick={() => openEditForm(record)}
          />
          <Popconfirm
            title={t("proxy_pool.confirm_delete")}
            onConfirm={() => handleDelete(record.id)}
          >
            <Button variant="dangerGhost" size="sm" iconOnly icon={<Trash2 />} />
          </Popconfirm>
        </div>
      ),
    },
  ];

  if (loading && pools.length === 0) return <GlobalLoading size="large" />;

  return (
    <PageContainer>
      <PageHeader
        icon={<Database size={20} className="text-zinc-500 dark:text-zinc-400" />}
        title={t("admin.proxy_pools")}
        description={t("admin.proxy_pools_desc")}
        extra={
          <div className="flex gap-2">
            <Button variant="default" icon={<RefreshCw />} onClick={handleRefresh} disabled={loading}>
              {t("common.refresh")}
            </Button>
            <Button variant="primary" icon={<Plus />} onClick={openCreateForm}>
              {t("proxy_pool.create_pool")}
            </Button>
          </div>
        }
      />

      <ProCard>
        <ResponsiveTable
          columns={columns}
          dataSource={pools}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 20, showTotal: (total) => t("common.pagination_total", { count: total }) }}
          scroll={{ x: 500 }}
        />
      </ProCard>

      <Modal
        title={editing ? t("proxy_pool.edit_pool") : t("proxy_pool.create_pool")}
        open={modalOpen}
        onCancel={closeForm}
        onOk={handleSubmit}
        confirmLoading={submitting}
        centered
        width={420}
        style={{ maxWidth: "90vw" }}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label={t("proxy_pool.name")}
            rules={[{ required: true }]}
          >
            <Input placeholder="default" />
          </Form.Item>
        </Form>
      </Modal>
    </PageContainer>
  );
}
