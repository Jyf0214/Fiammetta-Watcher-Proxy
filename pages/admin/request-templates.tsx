import { useState, useEffect } from "react";
import { Form, Input, Select, Modal, message } from "antd";
import { Button } from "@/components/ui/Button";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import GlobalLoading from "@/components/Loading";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import {
  FileText,
  Plus,
  Pencil,
  Trash2,
  Copy,
  Check,
} from "lucide-react";
import AdminLayout from "@/components/AdminLayout";

interface RequestTemplate {
  id: string;
  name: string;
  description: string;
  models: string[];
  mergeBody: Record<string, unknown>;
  enabled: boolean;
}

const EXAMPLE_BODIES = [
  {
    name: "启用深度思考",
    models: ["qwen-*", "deepseek-*"],
    body: {
      chat_template_kwargs: { enable_thinking: true },
    },
  },
  {
    name: "模型思考强度",
    models: ["deepseek-*"],
    body: {
      thinking: {
        reasoning_effort: "max",
      },
    },
  },
  {
    name: "强制 JSON 输出",
    models: ["gpt-4o", "gpt-4o-mini"],
    body: {
      response_format: { type: "json_object" },
    },
  },
  {
    name: "温度控制",
    models: ["*"],
    body: {
      temperature: 0.7,
      top_p: 0.9,
    },
  },
];

export default function RequestTemplatesPage() {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<RequestTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<RequestTemplate | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const [bodyJsonError, setBodyJsonError] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const fetchTemplates = async () => {
    try {
      const res = await fetch("/api/admin/request-templates");
      const data = await res.json() as Record<string, any>;
      if (data.success) {
        setTemplates(data.data);
      }
    } catch {
      // 静默失败
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const res = await fetch("/api/admin/request-templates", { signal: controller.signal });
        const data = await res.json() as Record<string, any>;
        if (data.success) {
          setTemplates(data.data);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };
    load();
    return () => controller.abort();
  }, []);

  const openCreateModal = () => {
    setEditingTemplate(null);
    form.resetFields();
    form.setFieldsValue({
      models: ["*"],
      enabled: true,
      mergeBody: JSON.stringify(EXAMPLE_BODIES[0].body, null, 2),
    });
    setBodyJsonError(false);
    setModalOpen(true);
  };

  const openEditModal = (tpl: RequestTemplate) => {
    setEditingTemplate(tpl);
    form.setFieldsValue({
      name: tpl.name,
      description: tpl.description,
      models: tpl.models,
      enabled: tpl.enabled,
      mergeBody: JSON.stringify(tpl.mergeBody, null, 2),
    });
    setBodyJsonError(false);
    setModalOpen(true);
  };

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
            models: values.models,
            mergeBody,
            enabled: values.enabled,
          }),
        });
        const data = await res.json() as Record<string, any>;
        if (data.success) {
          message.success(t("system.rt_update_success"));
          setModalOpen(false);
          fetchTemplates();
        } else {
          message.error(data.error);
        }
      } else {
        const res = await fetch("/api/admin/request-templates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: values.name,
            description: values.description,
            models: values.models,
            mergeBody,
          }),
        });
        const data = await res.json() as Record<string, any>;
        if (data.success) {
          message.success(t("system.rt_create_success"));
          setModalOpen(false);
          fetchTemplates();
        } else {
          message.error(data.error);
        }
      }
    } catch {
      // 表单校验失败
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (tpl: RequestTemplate) => {
    try {
      const res = await fetch("/api/admin/request-templates", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: tpl.id, enabled: !tpl.enabled }),
      });
      const data = await res.json() as Record<string, any>;
      if (data.success) {
        fetchTemplates();
      }
    } catch {
      // 静默失败
    }
  };

  const handleDelete = (tpl: RequestTemplate) => {
    Modal.confirm({
      title: t("system.rt_delete_confirm"),
      okText: t("common.confirm"),
      cancelText: t("common.cancel"),
      okType: "danger",
      onOk: async () => {
        try {
          const res = await fetch(`/api/admin/request-templates?id=${tpl.id}`, {
            method: "DELETE",
          });
          const data = await res.json() as Record<string, any>;
          if (data.success) {
            message.success(t("system.rt_delete_success"));
            fetchTemplates();
          } else {
            message.error(data.error);
          }
        } catch {
          message.error("删除失败");
        }
      },
    });
  };

  const handleCopyBody = (tpl: RequestTemplate) => {
    navigator.clipboard.writeText(JSON.stringify(tpl.mergeBody, null, 2));
    setCopiedId(tpl.id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const applyExample = (example: (typeof EXAMPLE_BODIES)[0]) => {
    form.setFieldsValue({
      name: example.name,
      models: example.models,
      mergeBody: JSON.stringify(example.body, null, 2),
    });
    setBodyJsonError(false);
  };

  if (loading) {
    return <AdminLayout><GlobalLoading size="large" /></AdminLayout>;
  }

  return (
    <AdminLayout>
      <PageContainer>
        <PageHeader
          icon={<FileText size={20} className="text-zinc-500 dark:text-zinc-400" />}
          title={t("system.request_templates_title")}
          description={t("system.request_templates_desc")}
          extra={
            <Button variant="primary" size="sm" onClick={openCreateModal} icon={<Plus size={14} />}>
              {t("system.rt_add")}
            </Button>
          }
        />

        {templates.length === 0 ? (
          <ProCard>
            <div className="text-center py-12 text-zinc-400">
              <FileText size={48} className="mx-auto mb-4 opacity-30" />
              <p className="text-sm">{t("system.rt_no_templates")}</p>
              <Button variant="primary" size="sm" className="mt-4" onClick={openCreateModal} icon={<Plus size={14} />}>
                {t("system.rt_add")}
              </Button>
            </div>
          </ProCard>
        ) : (
          <div className="space-y-3">
            {templates.map((tpl) => (
              <ProCard key={tpl.id}>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
                        {tpl.name}
                      </h3>
                      <span className="text-[10px] font-bold text-zinc-400 bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 rounded-full">
                        {tpl.models.length === 1 && tpl.models[0] === "*" ? "所有模型" : tpl.models.join(", ")}
                      </span>
                      {!tpl.enabled && (
                        <span className="text-[10px] font-bold text-zinc-300 dark:text-zinc-600">
                          {t("common.disabled") || "已禁用"}
                        </span>
                      )}
                    </div>
                    {tpl.description && (
                      <p className="text-xs text-zinc-400 mb-2">{tpl.description}</p>
                    )}
                    <div className="bg-zinc-50 dark:bg-zinc-800/50 rounded-lg p-3 font-mono text-xs text-zinc-600 dark:text-zinc-300 overflow-x-auto max-h-32">
                      <pre className="m-0">{JSON.stringify(tpl.mergeBody, null, 2)}</pre>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => handleToggle(tpl)}
                      className={`p-2 rounded-lg transition-colors ${
                        tpl.enabled
                          ? "text-green-500 hover:bg-green-50 dark:hover:bg-green-900/20"
                          : "text-zinc-300 dark:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      }`}
                      title={tpl.enabled ? t("system.rt_enabled") : t("common.disabled") || "已禁用"}
                    >
                      <Check size={16} className={tpl.enabled ? "" : "opacity-30"} />
                    </button>
                    <button
                      onClick={() => handleCopyBody(tpl)}
                      className="p-2 rounded-lg text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors"
                      title={t("common.copy") || "复制"}
                    >
                      {copiedId === tpl.id ? <Check size={16} className="text-green-500" /> : <Copy size={16} />}
                    </button>
                    <button
                      onClick={() => openEditModal(tpl)}
                      className="p-2 rounded-lg text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors"
                      title={t("common.edit") || "编辑"}
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      onClick={() => handleDelete(tpl)}
                      className="p-2 rounded-lg text-zinc-400 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-500 transition-colors"
                      title={t("common.delete") || "删除"}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              </ProCard>
            ))}
          </div>
        )}

        <Modal
          title={editingTemplate ? t("common.edit") : t("system.rt_add")}
          open={modalOpen}
          onCancel={() => setModalOpen(false)}
          onOk={handleSave}
          confirmLoading={saving}
          okText={t("common.save") || "保存"}
          cancelText={t("common.cancel")}
          width={640}
          destroyOnClose
        >
          <Form form={form} layout="vertical" initialValues={{ models: ["*"], enabled: true }}>
            <Form.Item
              name="name"
              label={t("system.rt_name")}
              rules={[{ required: true, message: t("validation.field_required") }]}
            >
              <Input placeholder={t("system.rt_name_placeholder")} />
            </Form.Item>

            <Form.Item name="description" label={t("system.rt_desc")}>
              <Input.TextArea rows={2} placeholder={t("system.rt_desc_placeholder")} />
            </Form.Item>

            <div className="flex flex-col sm:flex-row gap-4">
              <Form.Item name="models" label="适用模型" className="flex-1" extra="输入模型 ID 后按回车添加，支持 * 通配符（如 gpt-*）">
                <Select
                  mode="tags"
                  placeholder="输入模型 ID，回车确认"
                  tokenSeparators={[","]}
                />
              </Form.Item>

              <Form.Item name="enabled" label={t("system.rt_enabled")} valuePropName="checked">
                <input type="checkbox" className="w-4 h-4 mt-2" />
              </Form.Item>
            </div>

            {!editingTemplate && (
              <div className="mb-3">
                <p className="text-xs text-zinc-400 mb-2">快速填充示例：</p>
                <div className="flex flex-wrap gap-2">
                  {EXAMPLE_BODIES.map((ex) => (
                    <button
                      key={ex.name}
                      type="button"
                      onClick={() => applyExample(ex)}
                      className="text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors"
                    >
                      {ex.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <Form.Item
              name="mergeBody"
              label={t("system.rt_merge_body")}
              validateStatus={bodyJsonError ? "error" : undefined}
              help={bodyJsonError ? t("system.rt_json_error") : t("system.rt_merge_body_help")}
            >
              <Input.TextArea
                rows={8}
                placeholder={t("system.rt_merge_body_placeholder")}
                className="font-mono text-xs"
                onChange={() => setBodyJsonError(false)}
              />
            </Form.Item>
          </Form>
        </Modal>
      </PageContainer>
    </AdminLayout>
  );
}
