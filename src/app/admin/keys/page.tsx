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
  message,
  Popconfirm,
  Tooltip,
} from "antd";
import {
  PlusOutlined,
  DeleteOutlined,
  CopyOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";

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

  useEffect(() => {
    fetchKeys();
  }, []);

  const fetchKeys = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/keys");
      const data = await res.json();
      if (data.success) setKeys(data.data);
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

      const res = await fetch("/api/admin/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });

      const data = await res.json();
      if (data.success) {
        message.success(data.message);
        setModalOpen(false);
        form.resetFields();
        setNewKeyValue(data.data.key);
        setNewKeyVisible(true);
        fetchKeys();
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
      const res = await fetch(`/api/admin/keys?id=${id}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        message.success(data.message);
        fetchKeys();
      } else {
        message.error(data.error);
      }
    } catch {
      message.error(t("common.error"));
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    message.success("已复制到剪贴板");
  };

  const columns = [
    { title: t("api_key.name"), dataIndex: "name", key: "name" },
    {
      title: t("api_key.key"),
      dataIndex: "key",
      key: "key",
      render: (v: string) => (
        <Space>
          <span className="font-mono text-xs">{v.substring(0, 16)}...</span>
          <Tooltip title="复制">
            <Button
              size="small"
              type="text"
              icon={<CopyOutlined />}
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
      render: (v: number) => v.toLocaleString(),
    },
    {
      title: t("common.status"),
      dataIndex: "status",
      key: "status",
      render: (v: string) => {
        const colorMap: Record<string, string> = {
          active: "green",
          disabled: "red",
          expired: "orange",
        };
        return <Tag color={colorMap[v] || "default"}>{v}</Tag>;
      },
    },
    {
      title: t("common.created_at"),
      dataIndex: "createdAt",
      key: "createdAt",
      render: (v: string) => new Date(v).toLocaleString(),
    },
    {
      title: t("common.actions"),
      key: "actions",
      render: (_: unknown, record: ApiKeyItem) => (
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

  return (
    <div>
      <div className="mb-4 flex justify-between items-center">
        <h3 className="m-0">{t("admin.keys")}</h3>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            form.resetFields();
            setModalOpen(true);
          }}
        >
          {t("api_key.create_key")}
        </Button>
      </div>

      <Table
        columns={columns}
        dataSource={keys}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 20 }}
      />

      <Modal
        title={t("api_key.create_key")}
        open={modalOpen}
        onCancel={() => {
          setModalOpen(false);
          form.resetFields();
        }}
        onOk={handleSubmit}
        confirmLoading={submitting}
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
            <InputNumber min={0} className="w-full" placeholder="不限" />
          </Form.Item>
          <Form.Item name="callLimit" label={t("api_key.call_limit")}>
            <InputNumber min={0} className="w-full" placeholder="不限" />
          </Form.Item>
          <Form.Item name="rpmLimit" label={t("api_key.rpm_limit")}>
            <InputNumber min={0} className="w-full" placeholder="不限" />
          </Form.Item>
          <Form.Item name="tpmLimit" label={t("api_key.tpm_limit")}>
            <InputNumber min={0} className="w-full" placeholder="不限" />
          </Form.Item>
          <Form.Item
            name="resetPeriod"
            label={t("api_key.reset_period")}
            initialValue="monthly"
          >
            <Select>
              <Select.Option value="monthly">每月</Select.Option>
              <Select.Option value="daily">每日</Select.Option>
              <Select.Option value="never">不重置</Select.Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="API Key 已创建"
        open={newKeyVisible}
        onCancel={() => setNewKeyVisible(false)}
        footer={[
          <Button key="close" onClick={() => setNewKeyVisible(false)}>
            关闭
          </Button>,
        ]}
      >
        <p>请妥善保存此 Key，它不会再次显示：</p>
        <div className="bg-gray-100 p-3 rounded font-mono text-sm break-all">
          {newKeyValue}
        </div>
        <Button
          className="mt-3"
          icon={<CopyOutlined />}
          onClick={() => copyToClipboard(newKeyValue)}
        >
          复制 Key
        </Button>
      </Modal>
    </div>
  );
}
