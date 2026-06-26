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
  type TableColumnsType,
} from "antd";
import { PlusOutlined, EditOutlined, DeleteOutlined } from "@ant-design/icons";
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

  const columns: TableColumnsType<Platform> = [
    { title: t("platform.name"), dataIndex: "name", key: "name" },
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
      render: (v: string) => <Tag>{v}</Tag>,
      responsive: ["sm"],
    },
    {
      title: t("platform.priority"),
      dataIndex: "priority",
      key: "priority",
      responsive: ["lg"],
    },
    {
      title: t("platform.weight"),
      dataIndex: "weight",
      key: "weight",
      responsive: ["lg"],
    },
    {
      title: t("platform.rpm_limit"),
      dataIndex: "rpmLimit",
      key: "rpmLimit",
      render: (v: number | null) => v ?? "-",
      responsive: ["xl"],
    },
    {
      title: t("platform.tpm_limit"),
      dataIndex: "tpmLimit",
      key: "tpmLimit",
      render: (v: number | null) => v ?? "-",
      responsive: ["xl"],
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
      fixed: "right",
      width: 140,
      render: (_: unknown, record: Platform) => (
        <Space size="small">
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => {
              setEditing(record);
              form.setFieldsValue(record);
              setModalOpen(true);
            }}
          />
          <Popconfirm
            title={t("common.confirm_delete")}
            onConfirm={() => handleDelete(record.id)}
          >
            <Button size="small" danger icon={<DeleteOutlined />} />
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

      <div className="overflow-x-auto">
        <Table
          columns={columns}
          dataSource={platforms}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 20 }}
        />
      </div>

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
        width="min(90vw, 520px)"
        styles={{ body: { padding: '16px 24px' } }}
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Form.Item name="priority" label={t("platform.priority")} initialValue={0}>
              <InputNumber min={0} className="w-full" />
            </Form.Item>
            <Form.Item name="weight" label={t("platform.weight")} initialValue={1}>
              <InputNumber min={1} className="w-full" />
            </Form.Item>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Form.Item name="rpmLimit" label={t("platform.rpm_limit")}>
              <InputNumber min={0} placeholder={t("common.unlimited")} className="w-full" />
            </Form.Item>
            <Form.Item name="tpmLimit" label={t("platform.tpm_limit")}>
              <InputNumber min={0} placeholder={t("common.unlimited")} className="w-full" />
            </Form.Item>
          </div>
        </Form>
      </Modal>
    </div>
  );
}
