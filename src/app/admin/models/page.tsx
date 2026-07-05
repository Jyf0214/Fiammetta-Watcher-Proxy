"use client";

import { useState, useEffect } from "react";
import {
  Table,
  Modal,
  Form,
  Input,
  Select,
  Card,
  message,
  Popconfirm,
  type TableColumnsType,
} from "antd";
import { PlusOutlined, DeleteOutlined } from "@ant-design/icons";
import { Button } from "@/components/ui/Button";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import GlobalLoading from "@/components/Loading";

interface ModelMap {
  id: string;
  alias: string;
  targetModel: string;
  platformId: string | null;
  platform: { name: string } | null;
}

interface Platform {
  id: string;
  name: string;
}

export default function ModelsPage() {
  const { t } = useTranslation();
  const [models, setModels] = useState<ModelMap[]>([]);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);

  // 修复：将 fetchModels 提取为独立函数，供 useEffect 和操作回调共用
  const fetchModels = async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/models", { signal });
      const data = await res.json();
      if (data.success && Array.isArray(data.data)) setModels(data.data);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      console.error("获取模型列表失败:", err);
      message.error(t("common.error"));
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  };

  // 修复：将 fetchPlatforms 提取为独立函数
  const fetchPlatforms = async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/admin/platforms", { signal });
      const data = await res.json();
      if (data.success && Array.isArray(data.data)) setPlatforms(data.data);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      console.error("获取平台列表失败:", err);
      message.error(t("common.error"));
    }
  };

  // 修复：添加 AbortController 防止组件卸载后的竞态请求
  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchModels(controller.signal);
    fetchPlatforms(controller.signal);
    return () => controller.abort();
  }, []);

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);

      const res = await fetch("/api/admin/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });

      const data = await res.json();
      if (data.success) {
        message.success(data.message);
        setModalOpen(false);
        form.resetFields();
        fetchModels();
      } else {
        message.error(data.error);
      }
    } catch (err) {
      // 表单校验失败由 antd Form 自动处理，此处只捕获网络/服务器错误
      if (err instanceof Error && err.message.includes("validateFields")) return;
      message.error(t("common.error"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/models/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        message.success(data.message || t("model_map.delete_success") || "删除成功");
        fetchModels();
      } else {
        message.error(data.error || t("common.error"));
      }
    } catch {
      message.error(t("common.error"));
    }
  };

  const columns: TableColumnsType<ModelMap> = [
    {
      title: t("model_map.alias"),
      dataIndex: "alias",
      key: "alias",
      width: 200,
    },
    {
      title: t("model_map.target_model"),
      dataIndex: "targetModel",
      key: "targetModel",
      width: 240,
    },
    {
      title: t("model_map.platform"),
      key: "platform",
      width: 160,
      render: (_: unknown, record: ModelMap) =>
        record.platform?.name || t("model_map.auto_route"),
    },
    {
      title: t("common.actions"),
      key: "actions",
      width: 100,
      align: "center",
      render: (_: unknown, record: ModelMap) => (
        <Popconfirm
          title={t("common.confirm_delete")}
          onConfirm={() => handleDelete(record.id)}
        >
          <Button variant="dangerGhost" size="sm" icon={<DeleteOutlined />} iconOnly aria-label={t("common.delete")}>
          </Button>
        </Popconfirm>
      ),
    },
  ];

  if (loading && models.length === 0) {
    return <GlobalLoading size="large" />;
  }

  return (
    <div>
      <div className="border-b border-zinc-100 dark:border-zinc-800 pb-4 mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
          {t("admin.models")}
        </h1>
        <p className="text-zinc-500 dark:text-zinc-400 mt-1">
          {t("admin.models_desc")}
        </p>
      </div>

      <Card className="rounded-2xl shadow-sm border border-zinc-100 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-4 flex justify-end">
          <Button
            variant="primary"
            icon={<PlusOutlined />}
            aria-label={t("model_map.create_mapping")}
            onClick={() => {
              form.resetFields();
              setModalOpen(true);
            }}
          >
            {t("model_map.create_mapping")}
          </Button>
        </div>

        <div className="overflow-x-auto">
          <Table
            columns={columns}
            dataSource={models}
            rowKey="id"
            loading={loading}
            pagination={{ pageSize: 20 }}
            aria-label={t("admin.models")}
          />
        </div>
      </Card>

      <Modal
        title={t("model_map.create_mapping")}
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
        styles={{ body: { padding: "16px 24px" } }}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="alias"
            label={t("model_map.alias")}
            rules={[{ required: true }]}
          >
            <Input placeholder={t("model_map.alias_placeholder")} />
          </Form.Item>
          <Form.Item
            name="targetModel"
            label={t("model_map.target_model")}
            rules={[{ required: true }]}
          >
            <Input placeholder="gpt-4o-2024-08-06" />
          </Form.Item>
          <Form.Item name="platformId" label={t("model_map.platform")}>
            <Select allowClear placeholder={t("common.auto_select")}>
              {platforms.map((p) => (
                <Select.Option key={p.id} value={p.id}>
                  {p.name}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
