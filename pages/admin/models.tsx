/**
 * 模型映射管理页面
 *
 * 功能：
 * - 模型映射列表（表格展示，含关联平台信息）
 * - 新增映射（弹窗表单：别名 → 目标模型 + 可选平台）
 * - 删除映射（确认对话框）
 * - 支持通配符映射（别名以 * 结尾）
 *
 * 主分支对应文件：src/app/admin/models/page.tsx
 * 迁移变更：
 * - @lobehub/ui → Ant Design 5 原生组件
 * - 自定义组件 → Ant Design 标准组件
 * - react-i18next → 中文直接写死
 * - lucide-react 图标 → @ant-design/icons
 * - src/app/admin/models/page.tsx → pages/admin/models.tsx
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
  Select,
  Space,
  Popconfirm,
  Typography,
  message,
} from "antd";
import type { TableColumnsType } from "antd";
import {
  PlusOutlined,
  DeleteOutlined,
  SwapOutlined,
} from "@ant-design/icons";

const { Title, Text } = Typography;

// ==================== 类型定义 ====================

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

// ==================== 主组件 ====================

export default function ModelsPage() {
  const [models, setModels] = useState<ModelMap[]>([]);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);

  // ==================== 数据加载 ====================

  const fetchModels = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/models");
      const data: any = await res.json();
      if (data.success && Array.isArray(data.data)) {
        setModels(data.data);
      }
    } catch {
      message.error("加载模型映射失败");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchPlatforms = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/platforms");
      const data: any = await res.json();
      if (data.success && Array.isArray(data.data)) {
        setPlatforms(data.data);
      }
    } catch {
      // 加载平台列表失败不影响主流程
    }
  }, []);

  useEffect(() => {
    fetchModels();
    fetchPlatforms();
  }, [fetchModels, fetchPlatforms]);

  // ==================== CRUD 操作 ====================

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);

      const res = await fetch("/api/admin/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });

      const data: any = await res.json();
      if (data.success) {
        message.success(data.message || "映射已创建");
        setModalOpen(false);
        form.resetFields();
        fetchModels();
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
      const res = await fetch(`/api/admin/models/${id}`, { method: "DELETE" });
      const data: any = await res.json();
      if (data.success) {
        message.success(data.message || "删除成功");
        fetchModels();
      } else {
        message.error(data.error || "删除失败");
      }
    } catch {
      message.error("删除失败");
    }
  };

  // ==================== 表格列定义 ====================

  const columns: TableColumnsType<ModelMap> = [
    {
      title: "别名（客户端请求名）",
      dataIndex: "alias",
      key: "alias",
      width: 240,
      render: (v: string) => (
        <Text code>{v}</Text>
      ),
    },
    {
      title: "目标模型（上游模型名）",
      dataIndex: "targetModel",
      key: "targetModel",
      width: 260,
      render: (v: string) => (
        <Text code>{v}</Text>
      ),
    },
    {
      title: "绑定平台",
      key: "platform",
      width: 160,
      render: (_: unknown, record: ModelMap) =>
        record.platform ? (
          <Tag color="blue">{record.platform.name}</Tag>
        ) : (
          <Tag>自动路由</Tag>
        ),
    },
    {
      title: "操作",
      key: "actions",
      width: 80,
      align: "center",
      render: (_: unknown, record: ModelMap) => (
        <Popconfirm
          title="确定删除此映射？"
          onConfirm={() => handleDelete(record.id)}
          okText="删除"
          cancelText="取消"
        >
          <Button type="text" size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
  ];

  // ==================== 渲染 ====================

  return (
    <div style={{ padding: "24px" }}>
      <div style={{ marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>
            <SwapOutlined style={{ marginRight: 8 }} />
            模型映射
          </Title>
          <Text type="secondary">配置客户端模型名到上游模型名的映射关系</Text>
        </div>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => { form.resetFields(); setModalOpen(true); }}
        >
          新建映射
        </Button>
      </div>

      <Card>
        <Table
          columns={columns}
          dataSource={models}
          rowKey="id"
          loading={loading}
          pagination={{
            pageSize: 20,
            showTotal: (total) => `共 ${total} 条映射`,
          }}
        />
      </Card>

      {/* 新建映射弹窗 */}
      <Modal
        title="新建模型映射"
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
            name="alias"
            label="别名（客户端请求的模型名）"
            rules={[{ required: true, message: "请输入别名" }]}
          >
            <Input placeholder="例如：gpt-4 或 gpt-*（通配符）" />
          </Form.Item>
          <Form.Item
            name="targetModel"
            label="目标模型（发送给上游的模型名）"
            rules={[{ required: true, message: "请输入目标模型" }]}
          >
            <Input placeholder="例如：gpt-4o-2024-08-06" />
          </Form.Item>
          <Form.Item name="platformId" label="绑定平台（可选）">
            <Select allowClear placeholder="不指定则自动路由">
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
