import { useState, useEffect } from "react";
import { Form, Input, Select, Modal, message } from "antd";
import { Button } from "@/components/ui/Button";
import Switch from "@/components/ui/Switch";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import { AsyncBoundary } from "@/components/ui/AsyncBoundary";
import { EmptyState } from "@/components/ui/EmptyState";
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
import { useApi, UNAUTHORIZED_MESSAGE } from "@/hooks/use-api";
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
    nameKey: "rtExampleThinking",
    models: ["qwen-*", "deepseek-*"],
    body: {
      chat_template_kwargs: { enable_thinking: true },
    },
  },
  {
    nameKey: "rtExampleReasoning",
    models: ["deepseek-*"],
    body: {
      reasoning_effort: "max",
    },
  },
  {
    nameKey: "rtExampleJson",
    models: ["gpt-4o", "gpt-4o-mini"],
    body: {
      response_format: { type: "json_object" },
    },
  },
  {
    nameKey: "rtExampleTemperature",
    models: ["*"],
    body: {
      temperature: 0.7,
      top_p: 0.9,
    },
  },
];

export default function RequestTemplatesPage() {
  const { t } = useTranslation("system");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<RequestTemplate | null>(null);
  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [form] = Form.useForm();
  const [bodyJsonError, setBodyJsonError] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // 数据层：SWR 缓存 + 统一 fetcher（401 由 fetcher 统一提示并跳转登录页）
  const { data: templates, error, isLoading, mutate } = useApi<RequestTemplate[]>("/api/admin/request-templates");

  // 请求失败提示（401 已由 fetcher 统一提示并跳转登录页）
  useEffect(() => {
    if (error && error.message !== UNAUTHORIZED_MESSAGE) {
      message.error(t("common:error"));
    }
  }, [error, t]);

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
          message.success(t("rtUpdateSuccess"));
          setModalOpen(false);
          mutate();
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
            enabled: values.enabled,
            mergeBody,
          }),
        });
        const data = await res.json() as Record<string, any>;
        if (data.success) {
          message.success(t("rtCreateSuccess"));
          setModalOpen(false);
          mutate();
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
    setTogglingId(tpl.id);
    try {
      const res = await fetch("/api/admin/request-templates", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: tpl.id, enabled: !tpl.enabled }),
      });
      const data = await res.json() as Record<string, any>;
      if (data.success) {
        mutate();
      }
    } catch {
      // 静默失败
    } finally {
      setTogglingId(null);
    }
  };

  const handleDelete = (tpl: RequestTemplate) => {
    Modal.confirm({
      title: t("rtDeleteConfirm"),
      okText: t("common:confirm"),
      cancelText: t("common:cancel"),
      okType: "danger",
      onOk: async () => {
        try {
          const res = await fetch(`/api/admin/request-templates?id=${tpl.id}`, {
            method: "DELETE",
          });
          const data = await res.json() as Record<string, any>;
          if (data.success) {
            message.success(t("rtDeleteSuccess"));
            mutate();
          } else {
            message.error(data.error);
          }
        } catch {
          message.error(t("rtDeleteFailed"));
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
      name: t(example.nameKey),
      models: example.models,
      mergeBody: JSON.stringify(example.body, null, 2),
    });
    setBodyJsonError(false);
  };

  if (isLoading && !templates) {
    return (
      <AdminLayout>
        <PageContainer>
          <AsyncBoundary isLoading error={null}>
            <></>
          </AsyncBoundary>
        </PageContainer>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout>
      <PageContainer>
        <PageHeader
          icon={<FileText size={20} className="text-zinc-500 dark:text-zinc-400" />}
          title={t("requestTemplatesTitle")}
          description={t("requestTemplatesDesc")}
          extra={
            <Button variant="primary" size="sm" onClick={openCreateModal} icon={<Plus size={14} />}>
              {t("rtAdd")}
            </Button>
          }
        />

        {(templates ?? []).length === 0 ? (
          <ProCard>
            <EmptyState
              icon={<FileText className="w-12 h-12" />}
              title={t("rtNoTemplates")}
              action={
                <Button variant="primary" size="sm" onClick={openCreateModal} icon={<Plus size={14} />}>
                  {t("rtAdd")}
                </Button>
              }
            />
          </ProCard>
        ) : (
          <div className="space-y-3">
            {(templates ?? []).map((tpl) => (
              <ProCard key={tpl.id}>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
                        {tpl.name}
                      </h3>
                      <span className="text-[10px] font-bold text-zinc-400 bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 rounded-full">
                        {tpl.models.length === 1 && tpl.models[0] === "*" ? t("rtAllModels") : tpl.models.join(", ")}
                      </span>
                      {!tpl.enabled && (
                        <span className="text-[10px] font-bold text-zinc-500 dark:text-zinc-400">
                          {t("common:disabled")}
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
                  <div className="flex items-center gap-2 shrink-0">
                    <Switch
                      checked={tpl.enabled}
                      loading={togglingId === tpl.id}
                      onChange={() => handleToggle(tpl)}
                    />
                    <button
                      onClick={() => handleCopyBody(tpl)}
                      className="p-2 rounded-lg text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors"
                      title={t("common:copy")}
                    >
                      {copiedId === tpl.id ? <Check size={16} className="text-green-500" /> : <Copy size={16} />}
                    </button>
                    <button
                      onClick={() => openEditModal(tpl)}
                      className="p-2 rounded-lg text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors"
                      title={t("common:edit")}
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      onClick={() => handleDelete(tpl)}
                      className="p-2 rounded-lg text-zinc-400 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-500 transition-colors"
                      title={t("common:delete")}
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
          title={editingTemplate ? t("common:edit") : t("rtAdd")}
          open={modalOpen}
          onCancel={() => setModalOpen(false)}
          onOk={handleSave}
          confirmLoading={saving}
          okText={t("common:save")}
          cancelText={t("common:cancel")}
          width={640}
          destroyOnClose
        >
          <Form form={form} layout="vertical" initialValues={{ models: ["*"], enabled: true }}>
            <Form.Item
              name="name"
              label={t("rtName")}
              rules={[{ required: true, message: t("validation:required") }]}
            >
              <Input placeholder={t("rtNamePlaceholder")} />
            </Form.Item>

            <Form.Item name="description" label={t("rtDesc")}>
              <Input.TextArea rows={2} placeholder={t("rtDescPlaceholder")} />
            </Form.Item>

            <div className="flex flex-col sm:flex-row gap-4">
              <Form.Item name="models" label={t("rtModelsLabel")} className="flex-1" extra={t("rtModelsExtra")}>
                <Select
                  mode="tags"
                  placeholder={t("rtModelsPlaceholder")}
                  tokenSeparators={[","]}
                />
              </Form.Item>

              <Form.Item name="enabled" label={t("rtEnabled")} valuePropName="checked">
                <Switch />
              </Form.Item>
            </div>

            {!editingTemplate && (
              <div className="mb-3">
                <p className="text-xs text-zinc-400 mb-2">{t("rtExamplesTitle")}</p>
                <div className="flex flex-wrap gap-2">
                  {EXAMPLE_BODIES.map((ex) => (
                    <button
                      key={ex.nameKey}
                      type="button"
                      onClick={() => applyExample(ex)}
                      className="text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors"
                    >
                      {t(ex.nameKey)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <Form.Item
              name="mergeBody"
              label={t("rtMergeBody")}
              validateStatus={bodyJsonError ? "error" : undefined}
              help={bodyJsonError ? t("rtJsonError") : t("rtMergeBodyHelp")}
            >
              <Input.TextArea
                rows={8}
                placeholder={t("rtMergeBodyPlaceholder")}
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
