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
  Card,
  message,
  Popconfirm,
  Tooltip,
  type TableColumnsType,
} from "antd";
import {
  PlusOutlined,
  DeleteOutlined,
  CopyOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import GlobalLoading from "@/components/Loading";

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
    message.success(t("common.copied"));
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
              size="small"
              type="text"
              icon={<CopyOutlined />}
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
            size="small"
            danger
            icon={<DeleteOutlined />}
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
    <div>
      <div className="border-b border-zinc-100 dark:border-zinc-800 pb-4 mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mb-2">
          {t("admin.keys")}
        </h1>
        <p className="text-zinc-500 dark:text-zinc-400 mb-6">
          {t("admin.keys_desc")}
        </p>
      </div>

      <Card className="rounded-2xl shadow-sm border border-zinc-100 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-4 flex justify-between items-center">
          <span className="text-sm text-zinc-500 dark:text-zinc-400">
            {t("common.total")}: {keys.length}
          </span>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            aria-label={t("api_key.create_key")}
            onClick={() => {
              form.resetFields();
              setModalOpen(true);
            }}
          >
            {t("api_key.create_key")}
          </Button>
        </div>

        <div className="overflow-x-auto">
          <Table
            columns={columns}
            dataSource={keys}
            rowKey="id"
            loading={loading}
            aria-label={t("admin.keys")}
            pagination={{
              pageSize: 20,
              showTotal: (total) => t("common.pagination_total", { count: total }),
            }}
            scroll={{ x: 700 }}
          />
        </div>
      </Card>

      <Modal
        title={t("api_key.create_key")}
        open={modalOpen}
        onCancel={() => {
          setModalOpen(false);
          form.resetFields();
        }}
        onOk={handleSubmit}
        confirmLoading={submitting}
        width="min(90vw, 520px)"
        className="dark"
        styles={{
          header: { backgroundColor: "#1f1f1f", borderBottomColor: "#303030" },
          content: { backgroundColor: "#1f1f1f", borderRadius: "16px" },
          body: { padding: "16px 24px" },
          mask: { backgroundColor: "rgba(0,0,0,0.65)" },
        }}
      >
        <Form form={form} layout="vertical" className="dark">
          <Form.Item
            name="name"
            label={<span className="text-zinc-200">{t("api_key.name")}</span>}
            rules={[{ required: true }]}
          >
            <Input className="dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-100" />
          </Form.Item>
          <Form.Item name="tokenLimit" label={<span className="text-zinc-200">{t("api_key.token_limit")}</span>}>
            <InputNumber
              min={0}
              className="w-full"
              placeholder={t("common.unlimited")}
            />
          </Form.Item>
          <Form.Item name="callLimit" label={<span className="text-zinc-200">{t("api_key.call_limit")}</span>}>
            <InputNumber
              min={0}
              className="w-full"
              placeholder={t("common.unlimited")}
            />
          </Form.Item>
          <Form.Item name="rpmLimit" label={<span className="text-zinc-200">{t("api_key.rpm_limit")}</span>}>
            <InputNumber
              min={0}
              className="w-full"
              placeholder={t("common.unlimited")}
            />
          </Form.Item>
          <Form.Item name="tpmLimit" label={<span className="text-zinc-200">{t("api_key.tpm_limit")}</span>}>
            <InputNumber
              min={0}
              className="w-full"
              placeholder={t("common.unlimited")}
            />
          </Form.Item>
          <Form.Item
            name="resetPeriod"
            label={<span className="text-zinc-200">{t("api_key.reset_period")}</span>}
            initialValue="monthly"
          >
            <Select>
              <Select.Option value="monthly">
                {t("api_key.reset_monthly")}
              </Select.Option>
              <Select.Option value="daily">
                {t("api_key.reset_daily")}
              </Select.Option>
              <Select.Option value="never">
                {t("api_key.reset_never")}
              </Select.Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={t("api_key.created_title")}
        open={newKeyVisible}
        onCancel={() => setNewKeyVisible(false)}
        width="min(90vw, 520px)"
        className="dark"
        styles={{
          header: { backgroundColor: "#1f1f1f", borderBottomColor: "#303030" },
          content: { backgroundColor: "#1f1f1f", borderRadius: "16px" },
          body: { padding: "16px 24px" },
          mask: { backgroundColor: "rgba(0,0,0,0.65)" },
        }}
        footer={[
          <Button
            key="close"
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
          className="mt-3 w-full sm:w-auto"
          icon={<CopyOutlined />}
          aria-label={t("api_key.copy_key")}
          onClick={() => copyToClipboard(newKeyValue)}
        >
          {t("api_key.copy_key")}
        </Button>
      </Modal>
    </div>
  );
}
