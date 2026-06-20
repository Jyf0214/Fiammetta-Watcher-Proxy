"use client";

import { useState, useEffect } from "react";
import {
  Table,
  Button,
  Space,
  Tag,
  Modal,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  message,
  Popconfirm,
} from "antd";
import { PlusOutlined, EditOutlined, DeleteOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";

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
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Platform | null>(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchPlatforms();
  }, []);

  const fetchPlatforms = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/platforms");
      const data = await res.json();
      if (data.success) setPlatforms(data.data);
    } catch {
      message.error(t("common.error"));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);

      const url = editing
        ? `/api/admin/platforms?id=${editing.id}`
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
        setModalOpen(false);
        form.resetFields();
        setEditing(null);
        fetchPlatforms();
      } else {
        message.error(data.error);
      }
    } catch {
      // 表单校验失败
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/platforms?id=${id}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (data.success) {
        message.success(data.message);
        fetchPlatforms();
      } else {
        message.error(data.error);
      }
    } catch {
      message.error(t("common.error"));
    }
  };

  const handleToggle = async (platform: Platform) => {
    try {
      const res = await fetch(`/api/admin/platforms?id=${platform.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !platform.enabled }),
      });
      const data = await res.json();
      if (data.success) fetchPlatforms();
    } catch {
      message.error(t("common.error"));
    }
  };

  const columns = [
    { title: t("platform.name"), dataIndex: "name", key: "name" },
    { title: t("platform.base_url"), dataIndex: "baseUrl", key: "baseUrl", ellipsis: true },
    {
      title: t("platform.type"),
      dataIndex: "type",
      key: "type",
      render: (v: string) => <Tag>{v}</Tag>,
    },
    { title: t("platform.priority"), dataIndex: "priority", key: "priority" },
    { title: t("platform.weight"), dataIndex: "weight", key: "weight" },
    {
      title: t("platform.rpm_limit"),
      dataIndex: "rpmLimit",
      key: "rpmLimit",
      render: (v: number | null) => v ?? "-",
    },
    {
      title: t("platform.tpm_limit"),
      dataIndex: "tpmLimit",
      key: "tpmLimit",
      render: (v: number | null) => v ?? "-",
    },
    {
      title: t("common.status"),
      key: "enabled",
      render: (_: unknown, record: Platform) => (
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
      render: (_: unknown, record: Platform) => (
        <Space>
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => {
              setEditing(record);
              form.setFieldsValue(record);
              setModalOpen(true);
            }}
          >
            {t("common.edit")}
          </Button>
          <Popconfirm
            title={t("common.confirm_delete")}
            onConfirm={() => handleDelete(record.id)}
          >
            <Button size="small" danger icon={<DeleteOutlined />}>
              {t("common.delete")}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-4 flex justify-between items-center">
        <h3 className="m-0">{t("admin.platforms")}</h3>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            setEditing(null);
            form.resetFields();
            setModalOpen(true);
          }}
        >
          {t("platform.create_platform")}
        </Button>
      </div>

      <Table
        columns={columns}
        dataSource={platforms}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 20 }}
      />

      <Modal
        title={editing ? t("platform.edit_platform") : t("platform.create_platform")}
        open={modalOpen}
        onCancel={() => {
          setModalOpen(false);
          setEditing(null);
          form.resetFields();
        }}
        onOk={handleSubmit}
        confirmLoading={submitting}
      >
        <Form form={form} layout="vertical">
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
            rules={[{ required: true }]}
          >
            <Input.Password />
          </Form.Item>
          <Form.Item name="type" label={t("platform.type")} initialValue="openai">
            <Select>
              <Select.Option value="openai">OpenAI</Select.Option>
              <Select.Option value="azure">Azure</Select.Option>
              <Select.Option value="custom">Custom</Select.Option>
            </Select>
          </Form.Item>
          <Space>
            <Form.Item name="priority" label={t("platform.priority")} initialValue={0}>
              <InputNumber min={0} />
            </Form.Item>
            <Form.Item name="weight" label={t("platform.weight")} initialValue={1}>
              <InputNumber min={1} />
            </Form.Item>
          </Space>
          <Space>
            <Form.Item name="rpmLimit" label={t("platform.rpm_limit")}>
              <InputNumber min={0} placeholder="不限" />
            </Form.Item>
            <Form.Item name="tpmLimit" label={t("platform.tpm_limit")}>
              <InputNumber min={0} placeholder="不限" />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  );
}
