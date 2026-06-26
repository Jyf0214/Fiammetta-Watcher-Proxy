"use client";

import { useState, useEffect } from "react";
import {
  Table,
  Button,
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

  useEffect(() => {
    fetchModels();
    fetchPlatforms();
  }, []);

  const fetchModels = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/models");
      const data = await res.json();
      if (data.success) setModels(data.data);
    } catch {
      message.error(t("common.error"));
    } finally {
      setLoading(false);
    }
  };

  const fetchPlatforms = async () => {
    try {
      const res = await fetch("/api/admin/platforms");
      const data = await res.json();
      if (data.success) setPlatforms(data.data);
    } catch {
      message.error(t("common.error"));
    }
  };

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
    } catch {
      // 表单校验
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/models?id=${id}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        message.success(data.message);
        fetchModels();
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
          <Button size="small" danger icon={<DeleteOutlined />} aria-label={t("common.delete")}>
            {t("common.delete")}
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
            type="primary"
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
        width="min(90vw, 520px)"
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
