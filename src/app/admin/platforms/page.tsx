"use client";

import { useState, useEffect } from "react";
import {
  Table,
  Space,
  Tag,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  Card,
  message,
  Popconfirm,
  type TableColumnsType,
} from "antd";
import { Button } from "@/components/ui/Button";
import { PlusOutlined, EditOutlined, DeleteOutlined, CloseOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import GlobalLoading from "@/components/Loading";

interface Platform {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  type: string;
  enabled: boolean;
  priority: number;
  weight: number;
  rpmLimit: number | null;
  tpmLimit: number | null;
  status: string;
}

export default function PlatformsPage() {
  const { t } = useTranslation();
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [loading, setLoading] = useState(true);
  const [formVisible, setFormVisible] = useState(false);
  const [editing, setEditing] = useState<Platform | null>(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const fetchPlatforms = async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/platforms", { signal });
      const data = await res.json();
      if (data.success && Array.isArray(data.data)) setPlatforms(data.data);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      console.error("获取数据失败:", err);
      message.error(t("common.error"));
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchPlatforms(controller.signal);
    return () => controller.abort();
  }, []);

  const openCreateForm = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ type: "openai", priority: 0, weight: 1 });
    setFormVisible(true);
  };

  const openEditForm = (platform: Platform) => {
    setEditing(platform);
    form.setFieldsValue(platform);
    setFormVisible(true);
  };

  const closeForm = () => {
    setFormVisible(false);
    setEditing(null);
    form.resetFields();
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);

      const url = editing
        ? `/api/admin/platforms/${editing.id}`
        : "/api/admin/platforms";
      const method = editing ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });

      const data = await res.json();
      if (data.success) {
        message.success(data.message);
        closeForm();
        fetchPlatforms();
      } else {
        message.error(data.error);
      }
    } catch (err) {
      if (!(err instanceof Error && err.message.includes("form"))) message.error(t("common.error"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/platforms/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        message.success(t("platform.delete_success") || "删除成功");
        fetchPlatforms();
      } else {
        message.error(data.error || t("common.error"));
      }
    } catch {
      message.error(t("common.error"));
    }
  };

  const handleToggle = async (platform: Platform) => {
    try {
      setTogglingId(platform.id);
      const res = await fetch(`/api/admin/platforms/${platform.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !platform.enabled }),
      });
      const data = await res.json();
      if (data.success) {
        fetchPlatforms();
      } else {
        message.error(data.error || t("common.error"));
      }
    } catch {
      message.error(t("common.error"));
    } finally {
      setTogglingId(null);
    }
  };

  const columns: TableColumnsType<Platform> = [
    {
      title: t("platform.name"),
      dataIndex: "name",
      key: "name",
      width: 140,
      ellipsis: true,
    },
    {
      title: t("platform.base_url"),
      dataIndex: "baseUrl",
      key: "baseUrl",
      ellipsis: true,
      responsive: ["md"],
    },
    {
      title: t("platform.type"),
      dataIndex: "type",
      key: "type",
      width: 100,
      render: (v: string) => <Tag>{v}</Tag>,
      responsive: ["sm"],
    },
    {
      title: t("platform.priority"),
      dataIndex: "priority",
      key: "priority",
      width: 80,
      align: "center",
      responsive: ["lg"],
    },
    {
      title: t("platform.weight"),
      dataIndex: "weight",
      key: "weight",
      width: 80,
      align: "center",
      responsive: ["lg"],
    },
    {
      title: t("platform.rpm_limit"),
      dataIndex: "rpmLimit",
      key: "rpmLimit",
      width: 100,
      align: "center",
      render: (v: number | null) => v ?? "-",
      responsive: ["xl"],
    },
    {
      title: t("platform.tpm_limit"),
      dataIndex: "tpmLimit",
      key: "tpmLimit",
      width: 100,
      align: "center",
      render: (v: number | null) => v ?? "-",
      responsive: ["xl"],
    },
    {
      title: t("common.status"),
      key: "enabled",
      width: 100,
      align: "center",
      render: (_: unknown, record: Platform) => (
        <Switch
          checked={record.enabled}
          loading={togglingId === record.id}
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
      render: (_: unknown, record: Platform) => (
        <Space size="small">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<EditOutlined />}
            aria-label={t("common.edit")}
            onClick={() => openEditForm(record)}
          />
          <Popconfirm
            title={t("common.confirm_delete")}
            onConfirm={() => handleDelete(record.id)}
          >
            <Button
              variant="dangerGhost"
              size="sm"
              iconOnly
              icon={<DeleteOutlined />}
              aria-label={t("common.delete")}
            />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  if (loading && platforms.length === 0) {
    return <GlobalLoading size="large" />;
  }

  return (
    <div>
      <div className="border-b border-zinc-100 dark:border-zinc-800 pb-4 mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mb-2">
          {t("admin.platforms")}
        </h1>
        <p className="text-zinc-500 dark:text-zinc-400 mb-6">
          {t("admin.platforms_desc")}
        </p>
      </div>

      <Card className="rounded-2xl shadow-sm border border-zinc-100 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-4 flex justify-between items-center">
          <span className="text-sm text-zinc-500 dark:text-zinc-400">
            {t("common.total")}: {platforms.length}
          </span>
          <Button
            variant="primary"
            icon={<PlusOutlined />}
            aria-label={t("platform.create_platform")}
            onClick={openCreateForm}
          >
            {t("platform.create_platform")}
          </Button>
        </div>

        <div className="overflow-x-auto">
          <Table
            columns={columns}
            dataSource={platforms}
            rowKey="id"
            loading={loading}
            aria-label={t("admin.platforms")}
            pagination={{
              pageSize: 20,
              showTotal: (total) => t("common.pagination_total", { count: total }),
            }}
            scroll={{ x: 900 }}
          />
        </div>
      </Card>

      {/* 内联创建/编辑表单 */}
      {formVisible && (
        <Card
          className="mt-6 rounded-2xl shadow-sm border border-zinc-100 dark:border-zinc-800 dark:bg-zinc-900"
          title={
            <div className="flex items-center justify-between">
              <span className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                {editing ? t("platform.edit_platform") : t("platform.create_platform")}
              </span>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={<CloseOutlined />}
                onClick={closeForm}
                aria-label={t("common.close")}
              />
            </div>
          }
        >
          <Form form={form} layout="vertical" onFinish={handleSubmit}>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <Form.Item
                name="name"
                label={t("platform.name")}
                rules={[{ required: true }]}
              >
                <Input />
              </Form.Item>
              <Form.Item
                name="baseUrl"
                label={t("platform.base_url")}
                rules={[{ required: true }]}
              >
                <Input placeholder="https://api.openai.com/v1" />
              </Form.Item>
              <Form.Item
                name="apiKey"
                label={t("platform.api_key")}
                rules={editing ? [] : [{ required: true }]}
              >
                <Input.Password
                  placeholder={editing ? t("platform.api_key_edit_hint") : undefined}
                />
              </Form.Item>
              <Form.Item
                name="type"
                label={t("platform.type")}
                initialValue="openai"
              >
                <Select>
                  <Select.Option value="openai">OpenAI</Select.Option>
                  <Select.Option value="azure">Azure</Select.Option>
                  <Select.Option value="custom">Custom</Select.Option>
                </Select>
              </Form.Item>
              <Form.Item
                name="priority"
                label={t("platform.priority")}
                initialValue={0}
              >
                <InputNumber min={0} className="w-full" />
              </Form.Item>
              <Form.Item
                name="weight"
                label={t("platform.weight")}
                initialValue={1}
              >
                <InputNumber min={1} className="w-full" />
              </Form.Item>
              <Form.Item name="rpmLimit" label={t("platform.rpm_limit")}>
                <InputNumber
                  min={0}
                  placeholder={t("common.unlimited")}
                  className="w-full"
                />
              </Form.Item>
              <Form.Item name="tpmLimit" label={t("platform.tpm_limit")}>
                <InputNumber
                  min={0}
                  placeholder={t("common.unlimited")}
                  className="w-full"
                />
              </Form.Item>
            </div>
            <div className="flex justify-end gap-3 mt-4 pt-4 border-t border-zinc-100 dark:border-zinc-800">
              <Button variant="default" onClick={closeForm}>
                {t("common.cancel")}
              </Button>
              <Button variant="primary" type="submit" disabled={submitting}>
                {submitting ? t("common.loading") : editing ? t("common.save") : t("common.create")}
              </Button>
            </div>
          </Form>
        </Card>
      )}
    </div>
  );
}
