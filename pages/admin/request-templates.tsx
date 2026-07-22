/**
 * 请求模板管理页面
 *
 * 功能：
 * - 请求模板列表（卡片形式，显示名称/端点/描述/mergeBody JSON 预览）
 * - 新增/编辑模板（Modal 表单：名称/描述/端点/启用/mergeBody JSON 编辑器）
 * - 启用/禁用切换、复制 mergeBody、删除
 * - 快速填充示例（深度思考、JSON 输出、温度控制）
 *
 * 主分支对应文件：src/app/admin/request-templates/page.tsx
 * 迁移变更：
 * - @lobehub/ui → Ant Design 5 原生组件
 * - 自定义组件（PageContainer/PageHeader/ProCard）→ antd 标准组件
 * - react-i18next → 中文直接写死
 * - useRouter from next/navigation → next/router（Pages Router）
 * - src/app/admin/request-templates/page.tsx → pages/admin/request-templates.tsx
 */

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";
import {
  Modal,
  Form,
  Input,
  Select,
  Button,
  Card,
  Switch,
  message,
  Typography,
  Spin,
  Space,
  Tag,
} from "antd";

const { Title, Text } = Typography;
const { TextArea } = Input;

// ==================== 类型定义 ====================

interface RequestTemplate {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  mergeBody: Record<string, unknown>;
  enabled: boolean;
}

// ==================== 常量 ====================

const ENDPOINT_OPTIONS = [
  { value: "all", label: "所有端点" },
  { value: "chat/completions", label: "chat/completions" },
  { value: "completions", label: "completions" },
  { value: "embeddings", label: "embeddings" },
  { value: "images/generations", label: "images/generations" },
  { value: "audio/speech", label: "audio/speech" },
  { value: "audio/transcriptions", label: "audio/transcriptions" },
];

const EXAMPLE_BODIES = [
  {
    name: "启用深度思考",
    endpoint: "chat/completions",
    body: {
      extra_body: {
        chat_template_kwargs: { enable_thinking: true },
      },
    },
  },
  {
    name: "强制 JSON 输出",
    endpoint: "chat/completions",
    body: {
      response_format: { type: "json_object" },
    },
  },
  {
    name: "温度控制",
    endpoint: "chat/completions",
    body: {
      temperature: 0.7,
      top_p: 0.9,
    },
  },
];

// ==================== 页面组件 ====================

export default function RequestTemplatesPage() {
  const router = useRouter();
  const [templates, setTemplates] = useState<RequestTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<RequestTemplate | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const [bodyJsonError, setBodyJsonError] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // 加载模板列表
  const fetchTemplates = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/admin/request-templates", { signal });
      if (res.status === 401) {
        message.warning("登录已过期，请重新登录");
        router.push("/admin/login");
        return;
      }
      const data: any = await res.json();
      if (data.success) {
        setTemplates(data.data);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    const controller = new AbortController();
    fetchTemplates(controller.signal);
    return () => controller.abort();
  }, [fetchTemplates]);

  // 打开新增 Modal
  const openCreateModal = () => {
    setEditingTemplate(null);
    form.resetFields();
    form.setFieldsValue({
      endpoint: "all",
      enabled: true,
      mergeBody: JSON.stringify(EXAMPLE_BODIES[0].body, null, 2),
    });
    setBodyJsonError(false);
    setModalOpen(true);
  };

  // 打开编辑 Modal
  const openEditModal = (tpl: RequestTemplate) => {
    setEditingTemplate(tpl);
    form.setFieldsValue({
      name: tpl.name,
      description: tpl.description,
      endpoint: tpl.endpoint,
      enabled: tpl.enabled,
      mergeBody: JSON.stringify(tpl.mergeBody, null, 2),
    });
    setBodyJsonError(false);
    setModalOpen(true);
  };

  // 保存模板
  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      let mergeBody: Record<string, unknown>;
      try {
        mergeBody = JSON.parse(values.mergeBody);
      } catch {
        setBodyJsonError(true);
        return;
      }

      if (typeof mergeBody !== "object" || mergeBody === null || Array.isArray(mergeBody)) {
        setBodyJsonError(true);
        return;
      }

      setSaving(true);

      if (editingTemplate) {
        const res = await fetch("/api/admin/request-templates", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: editingTemplate.id,
            name: values.name,
            description: values.description,
            endpoint: values.endpoint,
            mergeBody,
            enabled: values.enabled,
          }),
        });
        const data: any = await res.json();
        if (data.success) {
          message.success("更新成功");
          setModalOpen(false);
          fetchTemplates();
        } else {
          message.error(data.error || "更新失败");
        }
      } else {
        const res = await fetch("/api/admin/request-templates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: values.name,
            description: values.description,
            endpoint: values.endpoint,
            mergeBody,
          }),
        });
        const data: any = await res.json();
        if (data.success) {
          message.success("创建成功");
          setModalOpen(false);
          fetchTemplates();
        } else {
          message.error(data.error || "创建失败");
        }
      }
    } catch {
      // 表单校验失败
    } finally {
      setSaving(false);
    }
  };

  // 启用/禁用切换
  const handleToggle = async (tpl: RequestTemplate) => {
    try {
      const res = await fetch("/api/admin/request-templates", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: tpl.id, enabled: !tpl.enabled }),
      });
      const data: any = await res.json();
      if (data.success) {
        fetchTemplates();
      }
    } catch {
      // 静默失败
    }
  };

  // 删除模板
  const handleDelete = (tpl: RequestTemplate) => {
    Modal.confirm({
      title: `确定删除模板「${tpl.name}」？`,
      okText: "确认",
      cancelText: "取消",
      okType: "danger",
      onOk: async () => {
        try {
          const res = await fetch(`/api/admin/request-templates?id=${tpl.id}`, {
            method: "DELETE",
          });
          const data: any = await res.json();
          if (data.success) {
            message.success("删除成功");
            fetchTemplates();
          } else {
            message.error(data.error || "删除失败");
          }
        } catch {
          message.error("删除失败");
        }
      },
    });
  };

  // 复制 mergeBody 到剪贴板
  const handleCopyBody = async (tpl: RequestTemplate) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(tpl.mergeBody, null, 2));
      setCopiedId(tpl.id);
      message.success("已复制到剪贴板");
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      message.error("复制失败");
    }
  };

  // 快速填充示例
  const applyExample = (example: { name: string; body: Record<string, unknown> }) => {
    form.setFieldsValue({
      mergeBody: JSON.stringify(example.body, null, 2),
    });
    setBodyJsonError(false);
  };

  if (loading) {
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
          <Title level={4} style={{ margin: 0 }}>请求模板</Title>
          <p className="text-zinc-500 text-xs mt-1">管理请求模板，为不同端点预设参数配置</p>
        </div>
        <Button type="primary" onClick={openCreateModal}>添加模板</Button>
      </div>

      {/* 模板列表 */}
      <div className="space-y-3">
        {templates.map((tpl) => (
          <Card key={tpl.id} size="small" className="shadow-sm">
            <div className="flex items-start justify-between">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-semibold text-sm">{tpl.name}</span>
                  <Tag color="blue" className="text-xs">{tpl.endpoint}</Tag>
                  {!tpl.enabled && (
                    <span className="text-[10px] font-bold text-zinc-300">已禁用</span>
                  )}
                </div>
                {tpl.description && (
                  <p className="text-xs text-zinc-400 mb-2">{tpl.description}</p>
                )}
                <div className="bg-zinc-50 rounded-lg p-3 font-mono text-xs text-zinc-600 overflow-x-auto max-h-32">
                  <pre className="m-0">{JSON.stringify(tpl.mergeBody, null, 2)}</pre>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0 ml-3">
                <Switch
                  checked={tpl.enabled}
                  checkedChildren="启用"
                  unCheckedChildren="禁用"
                  onChange={() => handleToggle(tpl)}
                  size="small"
                />
                <Button type="text" size="small" onClick={() => handleCopyBody(tpl)}>
                  {copiedId === tpl.id ? "已复制" : "复制"}
                </Button>
                <Button type="text" size="small" onClick={() => openEditModal(tpl)}>
                  编辑
                </Button>
                <Button type="text" size="small" danger onClick={() => handleDelete(tpl)}>
                  删除
                </Button>
              </div>
            </div>
          </Card>
        ))}
        {templates.length === 0 && (
          <div className="text-center py-8 text-zinc-500">暂无模板</div>
        )}
      </div>

      {/* 新增/编辑 Modal */}
      <Modal
        title={editingTemplate ? "编辑模板" : "添加模板"}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSave}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        width={640}
        destroyOnClose
      >
        <Form form={form} layout="vertical" initialValues={{ endpoint: "all", enabled: true }}>
          <Form.Item
            name="name"
            label="模板名称"
            rules={[{ required: true, message: "请输入模板名称" }]}
          >
            <Input placeholder="输入模板名称" />
          </Form.Item>

          <Form.Item name="description" label="描述">
            <TextArea rows={2} placeholder="输入模板描述（可选）" />
          </Form.Item>

          <div className="flex gap-4">
            <Form.Item name="endpoint" label="适用端点" className="flex-1">
              <Select options={ENDPOINT_OPTIONS} />
            </Form.Item>

            <Form.Item name="enabled" label="启用" valuePropName="checked">
              <Switch checkedChildren="启用" unCheckedChildren="禁用" />
            </Form.Item>
          </div>

          {!editingTemplate && (
            <div className="mb-3">
              <p className="text-xs text-zinc-400 mb-2">快速填充示例：</p>
              <Space wrap>
                {EXAMPLE_BODIES.map((ex) => (
                  <Button
                    key={ex.name}
                    size="small"
                    onClick={() => applyExample(ex)}
                  >
                    {ex.name}
                  </Button>
                ))}
              </Space>
            </div>
          )}

          <Form.Item
            name="mergeBody"
            label="Merge Body (JSON)"
            validateStatus={bodyJsonError ? "error" : undefined}
            help={bodyJsonError ? "JSON 格式错误，请检查语法" : "合并到请求 body 的 JSON 对象"}
          >
            <TextArea
              rows={8}
              placeholder='{"temperature": 0.7}'
              className="font-mono text-xs"
              onChange={() => setBodyJsonError(false)}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
