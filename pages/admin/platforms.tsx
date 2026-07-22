/**
 * 平台管理页面
 *
 * 功能：
 * - 平台列表（表格展示，支持分页）
 * - 新增/编辑平台（表单弹窗）
 * - 启用/禁用切换
 * - 删除平台（确认对话框）
 * - 模型管理抽屉（查看/刷新/添加/删除模型）
 * - 多密钥管理（命名密钥列表）
 *
 * 主分支对应文件：src/app/admin/platforms/page.tsx
 * 迁移变更：
 * - @lobehub/ui → Ant Design 5 原生组件
 * - 自定义组件 → Ant Design 标准组件
 * - react-i18next → 中文直接写死
 * - lucide-react 图标 → @ant-design/icons
 * - src/app/admin/platforms/page.tsx → pages/admin/platforms.tsx
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
  Switch,
  Drawer,
  Typography,
  message,
  Tooltip,
} from "antd";
import type { TableColumnsType } from "antd";
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  DatabaseOutlined,
  ReloadOutlined,
  CloudServerOutlined,
  CopyOutlined,
  CloseOutlined,
} from "@ant-design/icons";

const { Title, Text } = Typography;
const { TextArea } = Input;

// ==================== 类型定义 ====================

interface Platform {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  apiKeys: string;
  type: string;
  enabled: boolean;
  priority: number;
  weight: number;
  rpmLimit: number | null;
  tpmLimit: number | null;
  forwardHeaders: string;
  status: string;
  failCount: number;
}

interface NamedApiKey {
  name: string;
  key: string;
}

interface PlatformModel {
  id: string;
  modelId: string;
  ownedBy: string | null;
  source: string;
  type: string;
  fetchedAt: number;
}

// ==================== 主组件 ====================

export default function PlatformsPage() {
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [loading, setLoading] = useState(true);
  const [formVisible, setFormVisible] = useState(false);
  const [editing, setEditing] = useState<Platform | null>(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // 命名密钥状态
  const [namedKeys, setNamedKeys] = useState<NamedApiKey[]>([{ name: "密钥1", key: "" }]);

  // 模型管理抽屉
  const [modelDrawerOpen, setModelDrawerOpen] = useState(false);
  const [modelPlatform, setModelPlatform] = useState<Platform | null>(null);
  const [models, setModels] = useState<PlatformModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [newModelId, setNewModelId] = useState("");

  // ==================== 数据加载 ====================

  const fetchPlatforms = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/platforms");
      const data: any = await res.json();
      if (data.success && Array.isArray(data.data)) {
        setPlatforms(data.data);
      }
    } catch {
      message.error("加载平台列表失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPlatforms();
  }, [fetchPlatforms]);

  // ==================== 平台 CRUD ====================

  const openCreateForm = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ type: "openai", priority: 0, weight: 1 });
    setNamedKeys([{ name: "密钥1", key: "" }]);
    setFormVisible(true);
  };

  const openEditForm = (platform: Platform) => {
    setEditing(platform);
    form.resetFields();
    form.setFieldsValue({
      name: platform.name,
      baseUrl: platform.baseUrl,
      type: platform.type,
      priority: platform.priority,
      weight: platform.weight,
      rpmLimit: platform.rpmLimit,
      tpmLimit: platform.tpmLimit,
      forwardHeaders: platform.forwardHeaders,
    });

    // 解析命名密钥
    const mainKey: NamedApiKey = { name: "主密钥", key: platform.apiKey };
    const extraKeys: NamedApiKey[] = [];
    try {
      const parsed = JSON.parse(platform.apiKeys || "[]");
      if (Array.isArray(parsed)) {
        extraKeys.push(
          ...parsed.map((k: NamedApiKey | string, i: number) =>
            typeof k === "string" ? { name: `密钥${i + 2}`, key: k } : k
          )
        );
      }
    } catch {
      // 忽略解析错误
    }
    setNamedKeys([mainKey, ...extraKeys]);
    setFormVisible(true);
  };

  const closeForm = () => {
    setFormVisible(false);
    setEditing(null);
    form.resetFields();
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);

      // 处理命名密钥
      const validKeys = namedKeys.filter((k) => k.key && k.key.trim());
      if (validKeys.length > 0) {
        values.apiKey = validKeys[0].key;
        values.apiKeys = validKeys.length > 1 ? JSON.stringify(validKeys.slice(1)) : "[]";
      }

      const url = editing
        ? `/api/admin/platforms/${editing.id}`
        : "/api/admin/platforms";
      const method = editing ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });

      const data: any = await res.json();
      if (data.success) {
        message.success(data.message || (editing ? "平台已更新" : "平台已创建"));
        closeForm();
        fetchPlatforms();
      } else {
        message.error(data.error || "操作失败");
      }
    } catch (err) {
      if (err && typeof err === "object" && "errorFields" in err) return;
      message.error("操作失败");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/platforms/${id}`, { method: "DELETE" });
      const data: any = await res.json();
      if (data.success) {
        message.success("删除成功");
        fetchPlatforms();
      } else {
        message.error(data.error || "删除失败");
      }
    } catch {
      message.error("删除失败");
    }
  };

  const handleToggle = async (platform: Platform) => {
    try {
      setTogglingId(platform.id);
      const res = await fetch(`/api/admin/platforms/${platform.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !platform.enabled }),
      });
      const data: any = await res.json();
      if (data.success) {
        fetchPlatforms();
      } else {
        message.error(data.error || "切换失败");
      }
    } catch {
      message.error("切换失败");
    } finally {
      setTogglingId(null);
    }
  };

  // ==================== 命名密钥管理 ====================

  const addNamedKey = () => {
    const existingNames = namedKeys.map((k) => k.name);
    let newIndex = 1;
    while (existingNames.includes(`密钥${newIndex}`)) newIndex++;
    setNamedKeys([...namedKeys, { name: `密钥${newIndex}`, key: "" }]);
  };

  const removeNamedKey = (index: number) => {
    if (namedKeys.length <= 1) {
      message.warning("至少保留一个密钥");
      return;
    }
    setNamedKeys(namedKeys.filter((_, i) => i !== index));
  };

  const updateKeyName = (index: number, name: string) => {
    const newKeys = [...namedKeys];
    newKeys[index] = { ...newKeys[index], name };
    setNamedKeys(newKeys);
  };

  const updateKeyValue = (index: number, key: string) => {
    const newKeys = [...namedKeys];
    newKeys[index] = { ...newKeys[index], key };
    setNamedKeys(newKeys);
  };

  // ==================== 模型管理 ====================

  const openModelDrawer = (platform: Platform) => {
    setModelPlatform(platform);
    setModelDrawerOpen(true);
    fetchModels(platform.id);
  };

  const fetchModels = async (platformId: string) => {
    setModelsLoading(true);
    try {
      const res = await fetch(`/api/admin/platforms/${platformId}/models`);
      const data: any = await res.json();
      if (data.success) setModels(data.data || []);
    } catch {
      message.error("加载模型列表失败");
    } finally {
      setModelsLoading(false);
    }
  };

  const handleRefreshModels = async () => {
    if (!modelPlatform) return;
    setRefreshing(true);
    try {
      const res = await fetch(`/api/admin/platforms/${modelPlatform.id}/models`, {
        method: "PUT",
      });
      const data: any = await res.json();
      if (data.success) {
        message.success(data.message || "模型已刷新");
        fetchModels(modelPlatform.id);
      } else {
        message.error(data.error || "刷新失败");
      }
    } catch {
      message.error("刷新失败");
    } finally {
      setRefreshing(false);
    }
  };

  const handleAddModel = async () => {
    if (!modelPlatform || !newModelId.trim()) return;
    try {
      const res = await fetch(`/api/admin/platforms/${modelPlatform.id}/models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId: newModelId.trim() }),
      });
      const data: any = await res.json();
      if (data.success) {
        message.success(data.message || "模型已添加");
        setNewModelId("");
        fetchModels(modelPlatform.id);
      } else {
        message.error(data.error || "添加失败");
      }
    } catch {
      message.error("添加失败");
    }
  };

  const handleDeleteModel = async (modelId: string) => {
    if (!modelPlatform) return;
    try {
      const res = await fetch(
        `/api/admin/platforms/${modelPlatform.id}/models?modelId=${modelId}`,
        { method: "DELETE" }
      );
      const data: any = await res.json();
      if (data.success) {
        message.success("模型已删除");
        fetchModels(modelPlatform.id);
      } else {
        message.error(data.error || "删除失败");
      }
    } catch {
      message.error("删除失败");
    }
  };

  // ==================== 表格列定义 ====================

  const columns: TableColumnsType<Platform> = [
    {
      title: "名称",
      dataIndex: "name",
      key: "name",
      width: 140,
      ellipsis: true,
    },
    {
      title: "Base URL",
      dataIndex: "baseUrl",
      key: "baseUrl",
      ellipsis: true,
      responsive: ["md"],
    },
    {
      title: "类型",
      dataIndex: "type",
      key: "type",
      width: 100,
      render: (v: string) => <Tag>{v}</Tag>,
      responsive: ["sm"],
    },
    {
      title: "优先级",
      dataIndex: "priority",
      key: "priority",
      width: 80,
      align: "center",
      responsive: ["lg"],
    },
    {
      title: "权重",
      dataIndex: "weight",
      key: "weight",
      width: 80,
      align: "center",
      responsive: ["lg"],
    },
    {
      title: "RPM 限制",
      dataIndex: "rpmLimit",
      key: "rpmLimit",
      width: 100,
      align: "center",
      render: (v: number | null) => v ?? "-",
      responsive: ["xl"],
    },
    {
      title: "TPM 限制",
      dataIndex: "tpmLimit",
      key: "tpmLimit",
      width: 100,
      align: "center",
      render: (v: number | null) => v ?? "-",
      responsive: ["xl"],
    },
    {
      title: "状态",
      key: "enabled",
      width: 100,
      align: "center",
      render: (_: unknown, record: Platform) => (
        <Switch
          checked={record.enabled}
          loading={togglingId === record.id}
          onChange={() => handleToggle(record)}
          checkedChildren="启用"
          unCheckedChildren="禁用"
        />
      ),
    },
    {
      title: "操作",
      key: "actions",
      fixed: "right",
      width: 150,
      align: "center",
      render: (_: unknown, record: Platform) => (
        <Space size="small">
          <Tooltip title="模型管理">
            <Button
              type="text"
              size="small"
              icon={<DatabaseOutlined />}
              onClick={() => openModelDrawer(record)}
            />
          </Tooltip>
          <Tooltip title="编辑">
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={() => openEditForm(record)}
            />
          </Tooltip>
          <Popconfirm
            title="确定删除此平台？"
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
            <CloudServerOutlined style={{ marginRight: 8 }} />
            平台管理
          </Title>
          <Text type="secondary">管理上游 API 平台的配置和密钥</Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreateForm}>
          新增平台
        </Button>
      </div>

      <Card>
        <Table
          columns={columns}
          dataSource={platforms}
          rowKey="id"
          loading={loading}
          pagination={{
            pageSize: 20,
            showTotal: (total) => `共 ${total} 个平台`,
          }}
          scroll={{ x: 900 }}
        />
      </Card>

      {/* 新增/编辑平台表单 */}
      <Modal
        title={editing ? "编辑平台" : "新增平台"}
        open={formVisible}
        onCancel={closeForm}
        onOk={handleSubmit}
        confirmLoading={submitting}
        width={720}
        style={{ maxWidth: "90vw" }}
        okText={editing ? "保存" : "创建"}
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "0 16px" }}>
            <Form.Item
              name="name"
              label="平台名称"
              rules={[{ required: true, message: "请输入平台名称" }]}
            >
              <Input placeholder="例如：OpenAI" />
            </Form.Item>
            <Form.Item
              name="baseUrl"
              label="Base URL"
              rules={[{ required: true, message: "请输入 Base URL" }]}
            >
              <Input placeholder="https://api.openai.com/v1" />
            </Form.Item>
            <Form.Item name="type" label="平台类型" initialValue="openai">
              <Select
                options={[
                  { value: "openai", label: "OpenAI" },
                  { value: "azure", label: "Azure" },
                  { value: "custom", label: "Custom" },
                ]}
              />
            </Form.Item>
            <Form.Item name="priority" label="优先级" initialValue={0}>
              <InputNumber min={0} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item name="weight" label="权重" initialValue={1}>
              <InputNumber min={1} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item name="rpmLimit" label="RPM 限制">
              <InputNumber min={0} placeholder="不限制" style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item name="tpmLimit" label="TPM 限制">
              <InputNumber min={0} placeholder="不限制" style={{ width: "100%" }} />
            </Form.Item>
          </div>
          <Form.Item name="forwardHeaders" label="透传请求头">
            <TextArea
              rows={2}
              placeholder='["X-Thinking-Mode", "X-Reasoning-Effort"]'
            />
          </Form.Item>

          {/* 命名密钥管理 */}
          <div style={{ borderTop: "1px solid #f0f0f0", paddingTop: 16, marginTop: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <Text strong>API 密钥</Text>
              <Button size="small" icon={<PlusOutlined />} onClick={addNamedKey}>
                添加密钥
              </Button>
            </div>
            {namedKeys.map((nk, index) => (
              <div
                key={index}
                style={{
                  display: "flex",
                  gap: 8,
                  marginBottom: 8,
                  alignItems: "center",
                }}
              >
                <Input
                  placeholder="密钥名称"
                  value={nk.name}
                  onChange={(e) => updateKeyName(index, e.target.value)}
                  style={{ width: 120 }}
                  size="small"
                />
                <Input.Password
                  placeholder="sk-..."
                  value={nk.key}
                  onChange={(e) => updateKeyValue(index, e.target.value)}
                  style={{ flex: 1 }}
                  size="small"
                />
                {namedKeys.length > 1 && (
                  <Button
                    type="text"
                    danger
                    size="small"
                    icon={<CloseOutlined />}
                    onClick={() => removeNamedKey(index)}
                  />
                )}
              </div>
            ))}
          </div>
        </Form>
      </Modal>

      {/* 模型管理抽屉 */}
      <Drawer
        title={
          <span>
            <DatabaseOutlined style={{ marginRight: 8 }} />
            {modelPlatform?.name} — 模型管理
          </span>
        }
        open={modelDrawerOpen}
        onClose={() => setModelDrawerOpen(false)}
        width={600}
      >
        <div style={{ marginBottom: 16, display: "flex", gap: 8 }}>
          <Input
            placeholder="输入模型 ID"
            value={newModelId}
            onChange={(e) => setNewModelId(e.target.value)}
            onPressEnter={handleAddModel}
            style={{ flex: 1 }}
          />
          <Button type="primary" size="small" onClick={handleAddModel} disabled={!newModelId.trim()}>
            添加
          </Button>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={handleRefreshModels}
            loading={refreshing}
          >
            刷新
          </Button>
        </div>
        <Table
          dataSource={models}
          loading={modelsLoading}
          rowKey="id"
          size="small"
          pagination={false}
          columns={[
            {
              title: "模型 ID",
              dataIndex: "modelId",
              key: "modelId",
              ellipsis: true,
            },
            {
              title: "类型",
              dataIndex: "type",
              key: "type",
              width: 80,
              render: (v: string) => {
                const typeMap: Record<string, { color: string; label: string }> = {
                  chat: { color: "blue", label: "文字" },
                  image: { color: "purple", label: "图片" },
                  audio: { color: "orange", label: "音频" },
                  embedding: { color: "green", label: "向量" },
                };
                const t = typeMap[v] || { color: "default", label: v };
                return <Tag color={t.color}>{t.label}</Tag>;
              },
            },
            {
              title: "来源",
              dataIndex: "source",
              key: "source",
              width: 80,
              render: (v: string) => (
                <Tag color={v === "auto" ? "cyan" : "default"}>
                  {v === "auto" ? "自动" : "手动"}
                </Tag>
              ),
            },
            {
              title: "操作",
              key: "actions",
              width: 60,
              align: "center",
              render: (_: unknown, record: PlatformModel) => (
                <Popconfirm
                  title="确定删除此模型？"
                  onConfirm={() => handleDeleteModel(record.modelId)}
                  okText="删除"
                  cancelText="取消"
                >
                  <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              ),
            },
          ]}
        />
      </Drawer>
    </div>
  );
}
