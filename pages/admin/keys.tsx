/**
 * API Key 管理页面
 *
 * 功能：
 * - API Key 列表（表格展示，含掩码密钥、状态、用量）
 * - 新增 Key（弹窗表单，含配额设置）
 * - 创建后显示完整密钥（一次性显示）
 * - 删除 Key（确认对话框）
 * - 复制密钥到剪贴板
 *
 * 主分支对应文件：src/app/admin/keys/page.tsx
 * 迁移变更：
 * - @lobehub/ui → Ant Design 5 原生组件
 * - 自定义组件 → Ant Design 标准组件
 * - react-i18next → 中文直接写死
 * - lucide-react 图标 → @ant-design/icons
 * - src/app/admin/keys/page.tsx → pages/admin/keys.tsx
 */

import { useState, useEffect, useCallback } from "react";
import {
  Card,
  Table,
  Tag,
  Button,
  Modal,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Popconfirm,
  Typography,
  message,
  Tooltip,
} from "antd";
import type { TableColumnsType } from "antd";
import {
  PlusOutlined,
  DeleteOutlined,
  CopyOutlined,
  KeyOutlined,
} from "@ant-design/icons";

const { Title, Text } = Typography;

// ==================== 类型定义 ====================

interface ApiKeyItem {
  id: string;
  key: string;
  name: string;
  usedTokens: number;
  tokenLimit: number | null;
  callLimit: number | null;
  callUsed: number;
  rpmLimit: number | null;
  tpmLimit: number | null;
  resetPeriod: string;
  status: string;
  expiresAt: number | null;
  createdAt: number;
}

// ==================== 主组件 ====================

export default function KeysPage() {
  const [keys, setKeys] = useState<ApiKeyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [newKeyVisible, setNewKeyVisible] = useState(false);
  const [newKeyValue, setNewKeyValue] = useState("");

  // ==================== 数据加载 ====================

  const fetchKeys = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/keys");
      const data: any = await res.json();
      if (data.success && Array.isArray(data.data)) {
        setKeys(data.data);
      }
    } catch {
      message.error("加载密钥列表失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  // ==================== CRUD 操作 ====================

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);

      const res = await fetch("/api/admin/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });

      const data: any = await res.json();
      if (data.success) {
        message.success(data.message || "密钥已创建");
        setModalOpen(false);
        form.resetFields();
        setNewKeyValue(data.data?.key || "");
        setNewKeyVisible(true);
        fetchKeys();
      } else {
        message.error(data.error || "创建失败");
      }
    } catch (err) {
      if (err && typeof err === "object" && "errorFields" in err) return;
      message.error("创建失败");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/keys/${id}`, { method: "DELETE" });
      const data: any = await res.json();
      if (data.success) {
        message.success("删除成功");
        fetchKeys();
      } else {
        message.error(data.error || "删除失败");
      }
    } catch {
      message.error("删除失败");
    }
  };

  const handleToggleStatus = async (key: ApiKeyItem) => {
    const newStatus = key.status === "active" ? "disabled" : "active";
    try {
      const res = await fetch(`/api/admin/keys/${key.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      const data: any = await res.json();
      if (data.success) {
        message.success(`密钥已${newStatus === "active" ? "启用" : "禁用"}`);
        fetchKeys();
      } else {
        message.error(data.error || "操作失败");
      }
    } catch {
      message.error("操作失败");
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success("已复制到剪贴板");
    } catch {
      message.error("复制失败");
    }
  };

  // ==================== 格式化工具 ====================

  const formatTokens = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  };

  const formatTime = (ts: number): string => {
    return new Date(ts * 1000).toLocaleString("zh-CN");
  };

  const statusColorMap: Record<string, string> = {
    active: "green",
    disabled: "red",
    expired: "orange",
  };

  const statusLabelMap: Record<string, string> = {
    active: "活跃",
    disabled: "已禁用",
    expired: "已过期",
  };

  // ==================== 表格列定义 ====================

  const columns: TableColumnsType<ApiKeyItem> = [
    {
      title: "名称",
      dataIndex: "name",
      key: "name",
      width: 140,
      ellipsis: true,
    },
    {
      title: "密钥",
      dataIndex: "key",
      key: "key",
      width: 200,
      render: (v: string) => (
        <Space size={4}>
          <Text code style={{ fontSize: 12 }}>{v}</Text>
          <Tooltip title="复制">
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined />}
              onClick={() => copyToClipboard(v)}
            />
          </Tooltip>
        </Space>
      ),
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 90,
      render: (v: string) => (
        <Tag color={statusColorMap[v] || "default"}>
          {statusLabelMap[v] || v}
        </Tag>
      ),
    },
    {
      title: "已用 Token",
      dataIndex: "usedTokens",
      key: "usedTokens",
      width: 120,
      align: "right",
      render: (v: number) => formatTokens(v),
    },
    {
      title: "Token 上限",
      dataIndex: "tokenLimit",
      key: "tokenLimit",
      width: 100,
      align: "right",
      render: (v: number | null) => (v != null ? formatTokens(v) : "不限"),
    },
    {
      title: "调用次数",
      key: "calls",
      width: 100,
      align: "right",
      render: (_: unknown, record: ApiKeyItem) => {
        if (record.callLimit != null) {
          return `${record.callUsed} / ${record.callLimit}`;
        }
        return String(record.callUsed);
      },
    },
    {
      title: "重置周期",
      dataIndex: "resetPeriod",
      key: "resetPeriod",
      width: 90,
      render: (v: string) => {
        const map: Record<string, string> = { monthly: "每月", daily: "每天", never: "不重置" };
        return map[v] || v;
      },
    },
    {
      title: "创建时间",
      dataIndex: "createdAt",
      key: "createdAt",
      width: 160,
      render: (v: number) => formatTime(v),
      responsive: ["lg"],
    },
    {
      title: "操作",
      key: "actions",
      fixed: "right",
      width: 120,
      align: "center",
      render: (_: unknown, record: ApiKeyItem) => (
        <Space size="small">
          <Tooltip title={record.status === "active" ? "禁用" : "启用"}>
            <Button
              type="text"
              size="small"
              onClick={() => handleToggleStatus(record)}
            >
              {record.status === "active" ? "禁用" : "启用"}
            </Button>
          </Tooltip>
          <Popconfirm
            title="确定删除此密钥？"
            onConfirm={() => handleDelete(record.id)}
            okText="删除"
            cancelText="取消"
          >
            <Button type="text" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  // ==================== 渲染 ====================

  return (
    <div style={{ padding: "24px" }}>
      <div style={{ marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>
            <KeyOutlined style={{ marginRight: 8 }} />
            API Key 管理
          </Title>
          <Text type="secondary">管理下游 API 访问密钥和配额</Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => { form.resetFields(); setModalOpen(true); }}>
          创建密钥
        </Button>
      </div>

      <Card>
        <Table
          columns={columns}
          dataSource={keys}
          rowKey="id"
          loading={loading}
          pagination={{
            pageSize: 20,
            showTotal: (total) => `共 ${total} 个密钥`,
          }}
          scroll={{ x: 900 }}
        />
      </Card>

      {/* 创建密钥弹窗 */}
      <Modal
        title="创建 API Key"
        open={modalOpen}
        onCancel={() => { setModalOpen(false); form.resetFields(); }}
        onOk={handleSubmit}
        confirmLoading={submitting}
        width={520}
        style={{ maxWidth: "90vw" }}
        okText="创建"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label="密钥名称"
            rules={[{ required: true, message: "请输入密钥名称" }]}
          >
            <Input placeholder="例如：测试密钥" />
          </Form.Item>
          <Form.Item name="tokenLimit" label="Token 上限">
            <InputNumber min={0} style={{ width: "100%" }} placeholder="不限制" />
          </Form.Item>
          <Form.Item name="callLimit" label="调用次数上限">
            <InputNumber min={0} style={{ width: "100%" }} placeholder="不限制" />
          </Form.Item>
          <Form.Item name="rpmLimit" label="RPM 限制">
            <InputNumber min={0} style={{ width: "100%" }} placeholder="不限制" />
          </Form.Item>
          <Form.Item name="tpmLimit" label="TPM 限制">
            <InputNumber min={0} style={{ width: "100%" }} placeholder="不限制" />
          </Form.Item>
          <Form.Item name="resetPeriod" label="重置周期" initialValue="monthly">
            <Select
              options={[
                { value: "monthly", label: "每月" },
                { value: "daily", label: "每天" },
                { value: "never", label: "不重置" },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 新密钥显示弹窗 */}
      <Modal
        title="密钥已创建"
        open={newKeyVisible}
        onCancel={() => setNewKeyVisible(false)}
        footer={[
          <Button key="close" onClick={() => setNewKeyVisible(false)} block>
            关闭
          </Button>,
        ]}
        width={520}
        style={{ maxWidth: "90vw" }}
      >
        <Text type="warning" style={{ display: "block", marginBottom: 12 }}>
          请立即保存此密钥，关闭后将无法再次查看完整密钥。
        </Text>
        <div
          style={{
            background: "#f5f5f5",
            padding: 12,
            borderRadius: 8,
            fontFamily: "monospace",
            fontSize: 13,
            wordBreak: "break-all",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>{newKeyValue}</span>
          <Button
            type="text"
            size="small"
            icon={<CopyOutlined />}
            onClick={() => copyToClipboard(newKeyValue)}
          />
        </div>
      </Modal>
    </div>
  );
}
