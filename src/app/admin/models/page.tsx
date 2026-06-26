"use client";

import { useState, useEffect } from "react";
import {
  Table,
  Button,
  Modal,
  Form,
  Input,
  Select,
  message,
  Popconfirm,
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

  const columns = [
    { title: t("model_map.alias"), dataIndex: "alias", key: "alias" },
    { title: t("model_map.target_model"), dataIndex: "targetModel", key: "targetModel" },
    {
      title: t("model_map.platform"),
      key: "platform",
      render: (_: unknown, record: ModelMap) =>
        record.platform?.name || t("model_map.auto_route"),
    },
    {
      title: t("common.actions"),
      key: "actions",
      render: (_: unknown, record: ModelMap) => (
        <Popconfirm
          title={t("common.confirm_delete")}
          onConfirm={() => handleDelete(record.id)}
        >
          <Button size="small" danger icon={<DeleteOutlined />}>
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
      <div className="mb-4 flex justify-between items-center">
        <h3 className="m-0">{t("admin.models")}</h3>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            form.resetFields();
            setModalOpen(true);
          }}
        >
          {t("model_map.create_mapping")}
        </Button>
      </div>

      <Table
        columns={columns}
        dataSource={models}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 20 }}
      />

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
        styles={{ body: { padding: '16px 24px' } }}
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
