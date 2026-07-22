/**
 * 代理池管理页面
 *
 * 功能：
 * - 代理池列表（名称/代理数量/启用状态），支持新增/编辑/删除
 * - 启用/禁用切换（Switch 组件）
 *
 * 主分支对应文件：src/app/admin/proxy-pools/page.tsx
 * 迁移变更：
 * - @lobehub/ui → Ant Design 5 原生组件
 * - 自定义组件（ResponsiveTable/PageContainer/PageHeader/ProCard/Switch）→ antd 标准组件
 * - react-i18next → 中文直接写死
 * - useRouter from next/navigation → next/router（Pages Router）
 * - src/app/admin/proxy-pools/page.tsx → pages/admin/proxy-pools.tsx
 */

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";
import {
  Table,
  Tag,
  Modal,
  Form,
  Input,
  Button,
  Card,
  Space,
  Popconfirm,
  Switch,
  message,
  Typography,
  Spin,
} from "antd";
import type { TableColumnsType } from "antd";

const { Title } = Typography;

// ==================== 类型定义 ====================

interface PoolItem {
  id: string;
  name: string;
  enabled: boolean;
  proxyCount: number;
  createdAt: string;
  updatedAt: string;
}

// ==================== 页面组件 ====================

export default function ProxyPoolsPage() {
  const router = useRouter();
  const [pools, setPools] = useState<PoolItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<PoolItem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();

  // 加载代理池列表
  useEffect(() => {
    const controller = new AbortController();

    const fetchPools = async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/admin/pools", { signal: controller.signal });
        if (res.status === 401) {
          message.warning("登录已过期，请重新登录");
          router.push("/admin/login");
          return;
        }
        const data: any = await res.json();
        if (data.success && Array.isArray(data.data)) setPools(data.data);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        message.error("加载代理池列表失败");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    fetchPools();
    return () => controller.abort();
  }, [router, refreshKey]);

  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  // 打开新增表单
  const openCreateForm = () => {
    setEditing(null);
    form.resetFields();
    setModalOpen(true);
  };

  // 打开编辑表单
  const openEditForm = (pool: PoolItem) => {
    setEditing(pool);
    form.setFieldsValue({ name: pool.name });
    setModalOpen(true);
  };

  // 关闭表单
  const closeForm = () => {
    setModalOpen(false);
    setEditing(null);
    form.resetFields();
  };

  // 提交表单（新增/编辑）
  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);

      if (editing) {
        const res = await fetch(`/api/admin/pools/${editing.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values),
        });
        const data: any = await res.json();
        if (data.success) {
          message.success("更新成功");
          closeForm();
          handleRefresh();
        } else {
          message.error(data.error || "更新失败");
        }
      } else {
        const res = await fetch("/api/admin/pools", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values),
        });
        const data: any = await res.json();
        if (data.success) {
          message.success("创建成功");
          closeForm();
          handleRefresh();
        } else {
          message.error(data.error || "创建失败");
        }
      }
    } catch (err) {
      if (err && typeof err === "object" && "errorFields" in err) return;
      message.error("操作失败");
    } finally {
      setSubmitting(false);
    }
  };

  // 删除代理池
  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/pools/${id}`, { method: "DELETE" });
      const data: any = await res.json();
      if (data.success) {
        message.success("删除成功");
        handleRefresh();
      } else {
        message.error(data.error || "删除失败");
      }
    } catch {
      message.error("删除失败");
    }
  };

  // 启用/禁用切换
  const handleToggle = async (pool: PoolItem) => {
    try {
      const res = await fetch(`/api/admin/pools/${pool.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !pool.enabled }),
      });
      const data: any = await res.json();
      if (data.success) handleRefresh();
      else message.error(data.error || "操作失败");
    } catch {
      message.error("操作失败");
    }
  };

  // 表格列定义
  const columns: TableColumnsType<PoolItem> = [
    {
      title: "名称",
      dataIndex: "name",
      key: "name",
      width: 200,
    },
    {
      title: "代理数",
      dataIndex: "proxyCount",
      key: "proxyCount",
      width: 100,
      align: "center",
      render: (v: number) => <Tag>{v}</Tag>,
    },
    {
      title: "状态",
      key: "enabled",
      width: 100,
      align: "center",
      render: (_: unknown, record: PoolItem) => (
        <Switch
          checked={record.enabled}
          checkedChildren="启用"
          unCheckedChildren="禁用"
          onChange={() => handleToggle(record)}
        />
      ),
    },
    {
      title: "操作",
      key: "actions",
      fixed: "right",
      width: 120,
      align: "center",
      render: (_: unknown, record: PoolItem) => (
        <Space size="small">
          <Button type="link" size="small" onClick={() => openEditForm(record)}>
            编辑
          </Button>
          <Popconfirm title="确定删除该代理池？" onConfirm={() => handleDelete(record.id)}>
            <Button type="link" size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  if (loading && pools.length === 0) {
    return (
      <div className="flex items-center justify-center" style={{ minHeight: "50vh" }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div className="p-6" style={{ maxWidth: 960, margin: "0 auto" }}>
      {/* 页面标题 */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <Title level={4} style={{ margin: 0 }}>代理池管理</Title>
          <p className="text-zinc-500 text-xs mt-1">管理代理分组，将代理按池组织和管理</p>
        </div>
        <Space>
          <Button onClick={handleRefresh} disabled={loading}>刷新</Button>
          <Button type="primary" onClick={openCreateForm}>添加池</Button>
        </Space>
      </div>

      {/* 代理池列表 */}
      <Card>
        <Table
          columns={columns}
          dataSource={pools}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 20, showTotal: (total) => `共 ${total} 条` }}
          scroll={{ x: 500 }}
          size="small"
        />
      </Card>

      {/* 新增/编辑 Modal */}
      <Modal
        title={editing ? "编辑代理池" : "添加代理池"}
        open={modalOpen}
        onCancel={closeForm}
        onOk={handleSubmit}
        confirmLoading={submitting}
        centered
        width={420}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label="池名称"
            rules={[{ required: true, message: "请输入池名称" }]}
          >
            <Input placeholder="default" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
