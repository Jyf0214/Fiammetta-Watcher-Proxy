/**
 * 系统 API Key 管理页
 *
 * 管理用于后台 API 认证的系统级 Key（Authorization: Bearer）。
 * 与 v1 代理 Key 完全隔离。
 */

import { useState, useEffect, useCallback } from "react";
import { Space, Popconfirm, Modal, Form, Input, Switch, Alert, message, type TableColumnsType } from "antd";
import { Plus, Trash2, Copy, Shield, Key } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { formatDateTime } from "@/lib/timezone";
import GlobalLoading from "@/components/Loading";
import AdminLayout from "@/components/AdminLayout";

interface SystemKeyItem {
  id: string;
  key: string;
  name: string;
  enabled: boolean;
  lastUsedAt: number | null;
  createdAt: number;
}

export default function SystemKeysPage() {
  const { t } = useTranslation();
  const [keys, setKeys] = useState<SystemKeyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [newKeyVisible, setNewKeyVisible] = useState(false);
  const [newKeyValue, setNewKeyValue] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const fetchKeys = async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/admin/system-keys", { signal: controller.signal });
        const data: Record<string, any> = await res.json();
        if (data.success && Array.isArray(data.data)) setKeys(data.data);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        message.error(t("common.error"));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    fetchKeys();
    return () => controller.abort();
  }, [t, refreshKey]);

  const handleRefresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const handleCreate = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const res = await fetch("/api/admin/system-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const data: Record<string, any> = await res.json();
      if (data.success) {
        message.success(data.message || "创建成功");
        setModalOpen(false);
        form.resetFields();
        setNewKeyValue(data.data.key);
        setNewKeyVisible(true);
        handleRefresh();
      } else {
        message.error(data.error || "创建失败");
      }
    } catch {
      /* validation error */
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/system-keys/${id}`, { method: "DELETE" });
      const data: Record<string, any> = await res.json();
      if (data.success) {
        message.success("已删除");
        handleRefresh();
      } else {
        message.error(data.error || "删除失败");
      }
    } catch {
      message.error("删除失败");
    }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    try {
      const res = await fetch(`/api/admin/system-keys/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data: Record<string, any> = await res.json();
      if (data.success) {
        message.success(enabled ? "已启用" : "已禁用");
        handleRefresh();
      } else {
        message.error(data.error || "操作失败");
      }
    } catch {
      message.error("操作失败");
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(
      () => message.success("已复制到剪贴板"),
      () => message.error("复制失败")
    );
  };

  const formatTime = (ts: number | null) => {
    if (!ts) return "—";
    return formatDateTime(ts);
  };

  const columns: TableColumnsType<SystemKeyItem> = [
    { title: "名称", dataIndex: "name", key: "name", width: 200 },
    {
      title: "密钥",
      dataIndex: "key",
      key: "key",
      width: 220,
      render: (key: string) => (
        <Space size={4}>
          <code className="text-xs bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 rounded">{key}</code>
          <Button variant="link" size="sm" onClick={() => copyToClipboard(key)}>
            <Copy size={14} />
          </Button>
        </Space>
      ),
    },
    {
      title: "状态",
      dataIndex: "enabled",
      key: "enabled",
      width: 100,
      render: (enabled: boolean, record) => (
        <Switch
          checked={enabled}
          size="small"
          onChange={(checked) => handleToggle(record.id, checked)}
        />
      ),
    },
    { title: "最后使用", dataIndex: "lastUsedAt", key: "lastUsedAt", width: 180, render: (v: number | null) => formatTime(v) },
    { title: "创建时间", dataIndex: "createdAt", key: "createdAt", width: 180, render: (v: number) => formatTime(v) },
    {
      title: "操作",
      key: "actions",
      width: 80,
      render: (_, record) => (
        <Popconfirm title="确认删除此系统 Key？" onConfirm={() => handleDelete(record.id)} okText="删除" cancelText="取消">
          <Button variant="dangerGhost" size="sm">
            <Trash2 size={14} />
          </Button>
        </Popconfirm>
      ),
    },
  ];

  if (loading) {
    return (
      <AdminLayout>
        <GlobalLoading size="large" />
      </AdminLayout>
    );
  }

  return (
    <AdminLayout>
      <PageContainer>
        <PageHeader
          icon={<Key size={20} className="text-zinc-500 dark:text-zinc-400" />}
          title="系统 API Key"
          description="用于后台 API 认证（Authorization: Bearer），不可用于 v1 代理"
          extra={
            <Button onClick={() => setModalOpen(true)}>
              <Plus size={16} className="mr-1" /> 创建系统 Key
            </Button>
          }
        />

        <ProCard>
          <ResponsiveTable
            columns={columns}
            dataSource={keys}
            rowKey="id"
            pagination={false}
          />
        </ProCard>

        {/* 创建弹窗 */}
        <Modal
          title="创建系统 API Key"
          open={modalOpen}
          onOk={handleCreate}
          onCancel={() => { setModalOpen(false); form.resetFields(); }}
          confirmLoading={submitting}
          okText="创建"
          cancelText="取消"
        >
          <Form form={form} layout="vertical" autoComplete="off">
            <Form.Item
              name="name"
              label="Key 名称"
              rules={[{ required: true, message: "请输入名称" }, { max: 100, message: "不超过 100 个字符" }]}
            >
              <Input placeholder="例如：本地开发、CI/CD 脚本" />
            </Form.Item>
          </Form>
          <div className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
            <Shield size={12} className="inline mr-1" />
            系统 Key 仅用于管理后台 API 认证，不可用于 v1 代理转发。
          </div>
        </Modal>

        {/* 新 Key 展示弹窗 */}
        <Modal
          title="系统 Key 创建成功"
          open={newKeyVisible}
          onOk={() => { setNewKeyVisible(false); setNewKeyValue(""); }}
          onCancel={() => { setNewKeyVisible(false); setNewKeyValue(""); }}
          okText="我已保存"
          cancelButtonProps={{ style: { display: "none" } }}
        >
          <Alert
            type="warning"
            message="密钥仅显示一次，请立即复制保存"
            className="mb-3"
          />
          <div className="bg-neutral-50 dark:bg-neutral-800 rounded p-3 font-mono text-sm break-all">
            {newKeyValue}
          </div>
          <Button
            className="mt-3"
            onClick={() => copyToClipboard(newKeyValue)}
          >
            <Copy size={14} className="mr-1" /> 复制密钥
          </Button>
        </Modal>
      </PageContainer>
    </AdminLayout>
  );
}
