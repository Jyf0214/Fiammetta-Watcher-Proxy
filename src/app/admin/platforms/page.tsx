"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Space,
  Tag,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  Drawer,
  Table,
  message,
  Popconfirm,
  type TableColumnsType,
} from "antd";
import { Button } from "@/components/ui/Button";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import { PlusOutlined, EditOutlined, DeleteOutlined, CloseOutlined, DatabaseOutlined, ReloadOutlined, CloudServerOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import GlobalLoading from "@/components/Loading";

interface Platform {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  apiKeys: string;
  type: string;
  enabled: boolean;
  priority: number;
  weight: number;
  rpmLimit: number | null;
  tpmLimit: number | null;
  forwardHeaders: string;
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

  const [modelDrawerOpen, setModelDrawerOpen] = useState(false);
  const [modelPlatform, setModelPlatform] = useState<Platform | null>(null);
  const [models, setModels] = useState<Array<{ id: string; modelId: string; ownedBy: string | null; source: string; fetchedAt: string }>>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [newModelId, setNewModelId] = useState("");

  const fetchPlatforms = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/platforms", { signal });
      const data = await res.json();
      if (data.success && Array.isArray(data.data)) setPlatforms(data.data);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      message.error(t("common.error"));
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, [t]);

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchPlatforms(controller.signal);
    return () => controller.abort();
  }, [fetchPlatforms]);

  const openCreateForm = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ type: "openai", priority: 0, weight: 1 });
    setFormVisible(true);
  };

  const openEditForm = (platform: Platform) => {
    setEditing(platform);
    let allKeys = platform.apiKey || "";
    if (platform.apiKeys) {
      try {
        const parsed = JSON.parse(platform.apiKeys);
        if (Array.isArray(parsed) && parsed.length > 0) {
          allKeys = [allKeys, ...parsed].join("\n");
        }
      } catch {
        // JSON 解析失败，忽略
      }
    }
    form.setFieldsValue({ ...platform, apiKey: allKeys });
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

      if (typeof values.apiKey === "string") {
        const lines = values.apiKey
          .split("\n")
          .map((line: string) => line.trim())
          .filter((line: string) => line.length > 0);
        if (lines.length > 0) {
          values.apiKey = lines[0];
          values.apiKeys = lines.length > 1 ? JSON.stringify(lines.slice(1)) : "[]";
        }
      }

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
        message.error(data.error || t("common.error"));
      }
    } catch (err) {
      if (err && typeof err === "object" && "errorFields" in err) return;
      message.error(t("common.error"));
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

  const openModelDrawer = (platform: Platform) => {
    setModelPlatform(platform);
    setModelDrawerOpen(true);
    fetchModels(platform.id);
  };

  const fetchModels = async (platformId: string) => {
    setModelsLoading(true);
    try {
      const res = await fetch(`/api/admin/platforms/${platformId}/models`);
      const data = await res.json();
      if (data.success) setModels(data.data || []);
    } catch {
      message.error(t("common.error"));
    } finally {
      setModelsLoading(false);
    }
  };

  const handleRefreshModels = async () => {
    if (!modelPlatform) return;
    setRefreshing(true);
    try {
      const res = await fetch(`/api/admin/platforms/${modelPlatform.id}/models`, {
        method: "PUT",
      });
      const data = await res.json();
      if (data.success) {
        message.success(data.message);
        fetchModels(modelPlatform.id);
      } else {
        message.error(data.error || t("common.error"));
      }
    } catch {
      message.error(t("common.error"));
    } finally {
      setRefreshing(false);
    }
  };

  const handleAddModel = async () => {
    if (!modelPlatform || !newModelId.trim()) return;
    try {
      const res = await fetch(`/api/admin/platforms/${modelPlatform.id}/models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId: newModelId.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        message.success(data.message);
        setNewModelId("");
        fetchModels(modelPlatform.id);
      } else {
        message.error(data.error || t("common.error"));
      }
    } catch {
      message.error(t("common.error"));
    }
  };

  const handleDeleteModel = async (modelId: string) => {
    if (!modelPlatform) return;
    try {
      const res = await fetch(
        `/api/admin/platforms/${modelPlatform.id}/models?modelId=${encodeURIComponent(modelId)}`,
        { method: "DELETE" }
      );
      const data = await res.json();
      if (data.success) {
        fetchModels(modelPlatform.id);
      } else {
        message.error(data.error || t("common.error"));
      }
    } catch {
      message.error(t("common.error"));
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
      width: 150,
      align: "center",
      render: (_: unknown, record: Platform) => (
        <Space size="small">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<DatabaseOutlined />}
            onClick={() => openModelDrawer(record)}
          />
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<EditOutlined />}
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
    <PageContainer>
      <PageHeader
        icon={<CloudServerOutlined size={20} className="text-zinc-500 dark:text-zinc-400" />}
        title={t("admin.platforms")}
        description={t("admin.platforms_desc")}
        extra={
          <Button
            variant="primary"
            icon={<PlusOutlined />}
            onClick={openCreateForm}
          >
            {t("platform.create_platform")}
          </Button>
        }
      />

      <ProCard>
        <ResponsiveTable
          columns={columns}
          dataSource={platforms}
          rowKey="id"
          loading={loading}
          pagination={{
            pageSize: 20,
            showTotal: (total) => t("common.pagination_total", { count: total }),
          }}
          scroll={{ x: 900 }}
        />
      </ProCard>

      {formVisible && (
        <ProCard
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
              />
            </div>
          }
          className="mt-4"
        >
          <Form form={form} layout="vertical" onFinish={handleSubmit} onFinishFailed={({ errorFields }) => {
            if (errorFields && errorFields.length > 0) {
              message.error(errorFields[0].errors[0] || t("validation.field_required"));
            }
          }}>
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
                tooltip={t("platform.additional_keys_tip") || "每行一个密钥，第一行为主密钥，后续行为附加密钥"}
                rules={editing ? [] : [{ required: true }]}
              >
                <Input.TextArea
                  rows={3}
                  placeholder={editing ? t("platform.api_key_edit_hint") : "每行一个密钥"}
                  className="font-mono text-xs"
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
              <Form.Item name="forwardHeaders" label={t("platform.forward_headers")}>
                <Input.TextArea
                  rows={2}
                  placeholder='["X-Thinking-Mode", "X-Reasoning-Effort"]'
                />
              </Form.Item>
            </div>
            <div className="flex justify-end gap-3 mt-4 pt-4 border-t border-zinc-100 dark:border-zinc-800">
              <Button variant="default" onClick={closeForm}>
                {t("common.cancel")}
              </Button>
              <Button variant="primary" type="submit" disabled={submitting} autoLoading={false}>
                {submitting ? t("common.loading") : editing ? t("common.save") : t("common.create")}
              </Button>
            </div>
          </Form>
        </ProCard>
      )}

      <Drawer
        title={
          <span className="flex items-center gap-2">
            <DatabaseOutlined />
            {modelPlatform?.name} — {t("platform.models") || "模型管理"}
          </span>
        }
        open={modelDrawerOpen}
        onClose={() => setModelDrawerOpen(false)}
        width={600}
      >
        <div className="mb-4 flex items-center gap-2">
          <Input
            placeholder={t("platform.model_placeholder") || "输入模型 ID"}
            value={newModelId}
            onChange={(e) => setNewModelId(e.target.value)}
            onPressEnter={handleAddModel}
            className="flex-1"
          />
          <Button variant="primary" size="sm" onClick={handleAddModel} disabled={!newModelId.trim()}>
            {t("common.create")}
          </Button>
          <Button
            variant="default"
            size="sm"
            icon={<ReloadOutlined />}
            onClick={handleRefreshModels}
            loading={refreshing}
          >
            {t("platform.refresh_models") || "刷新"}
          </Button>
        </div>
        <Table
          dataSource={models}
          loading={modelsLoading}
          rowKey="id"
          size="small"
          pagination={false}
          columns={[
            {
              title: t("platform.model_id") || "模型 ID",
              dataIndex: "modelId",
              key: "modelId",
              ellipsis: true,
            },
            {
              title: t("platform.model_source") || "来源",
              dataIndex: "source",
              key: "source",
              width: 80,
              render: (v: string) => (
                <Tag color={v === "manual" ? "green" : "blue"}>
                  {v === "manual" ? "手动" : "自动"}
                </Tag>
              ),
            },
            {
              title: t("common.actions"),
              key: "actions",
              width: 60,
              render: (_: unknown, record: { modelId: string }) => (
                <Popconfirm
                  title={t("common.confirm_delete")}
                  onConfirm={() => handleDeleteModel(record.modelId)}
                >
                  <Button variant="dangerGhost" size="sm" iconOnly icon={<DeleteOutlined />} />
                </Popconfirm>
              ),
            },
          ]}
        />
      </Drawer>
    </PageContainer>
  );
}
