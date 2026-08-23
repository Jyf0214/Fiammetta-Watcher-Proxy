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
import { copyToClipboard } from "@/lib/ui";
import AdminLayout from "@/components/AdminLayout";

interface RequestTemplate {
  id: string;
  name: string;
  description: string;
  models: string[];
  mergeBody: Record<string, unknown>;
  enabled: boolean;
  type?: "chat" | "responses";
}

const EXAMPLE_BODIES_CHAT = [
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

const EXAMPLE_BODIES_RESPONSES = [
  {
    nameKey: "rtExampleResponsesReasoningHigh",
    models: ["gpt-5*", "o3*", "o4*"],
    body: {
      reasoning: { effort: "high", summary: "detailed" },
      text: { verbosity: "high" },
    },
  },
  {
    nameKey: "rtExampleResponsesInstructions",
    models: ["gpt-4o*"],
    body: {
      instructions: "You are a helpful assistant that thinks step by step.",
      reasoning: { effort: "medium" },
    },
  },
  {
    nameKey: "rtExampleResponsesTools",
    models: ["*"],
    body: {
      tools: [{ type: "web_search_preview" }],
      tool_choice: "auto",
    },
  },
  {
    nameKey: "rtExampleResponsesTruncation",
    models: ["*"],
    body: {
      truncation: "auto",
      max_output_tokens: 4096,
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
  const typeWatch = Form.useWatch("type", form) as "chat" | "responses" | undefined;

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
      type: "chat",
      models: ["*"],
      enabled: true,
      mergeBody: JSON.stringify(EXAMPLE_BODIES_CHAT[0].body, null, 2),
    });
    setBodyJsonError(false);
    setModalOpen(true);
  };

  const openEditModal = (tpl: RequestTemplate) => {
    setEditingTemplate(tpl);
    form.setFieldsValue({
      name: tpl.name,
      description: tpl.description,
      type: tpl.type ?? "chat",
      models: tpl.models,
      enabled: tpl.enabled,
      mergeBody: JSON.stringify(tpl.mergeBody, null, 2),
    });
    setBodyJsonError(false);
    setModalOpen(true);
  };

  const handleSave = async () => {
    let values: { name: string; description?: string; type: "chat" | "responses"; models: string[]; enabled: boolean; mergeBody: string };
    try {
      values = await form.validateFields();
    } catch {
      // 表单校验失败：antd 已在对应字段下方显示错误，无需额外提示
      return;
    }

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
    try {
      const res = await fetch("/api/admin/request-templates", {
        method: editingTemplate ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(editingTemplate ? { id: editingTemplate.id } : {}),
          name: values.name,
          description: values.description,
          type: values.type,
          models: values.models,
          mergeBody,
          enabled: values.enabled,
        }),
      });
      const data = await res.json() as Record<string, any>;
      if (data.success) {
        message.success(editingTemplate ? t("rtUpdateSuccess") : t("rtCreateSuccess"));
        // 服务端白名单清洗会丢弃白名单外字段（如 chat 模板里的 tools），此处透出提示，
        // 避免"保存成功但部分字段被静默忽略"无任何感知
        const dropped = Array.isArray(data.droppedKeys) ? (data.droppedKeys as string[]) : [];
        if (dropped.length > 0) {
          message.warning(t("rtDroppedFieldsWarning", { fields: dropped.join(", ") }), 6);
        }
        setModalOpen(false);
        mutate();
      } else {
        message.error(typeof data.error === "string" ? data.error : t("common:error"));
      }
    } catch {
      // 网络异常与表单校验失败分离：此处是真实请求失败，必须提示
      message.error(t("common:networkError"));
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
      } else {
        message.error(typeof data.error === "string" ? data.error : t("common:error"));
      }
    } catch {
      message.error(t("common:networkError"));
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
            message.error(typeof data.error === "string" ? data.error : t("common:error"));
          }
        } catch {
          message.error(t("rtDeleteFailed"));
        }
      },
    });
  };

  const handleCopyBody = async (tpl: RequestTemplate) => {
    // 复制统一走共享工具（HTTP 环境降级 execCommand），失败时给出明确反馈
    const ok = await copyToClipboard(JSON.stringify(tpl.mergeBody, null, 2));
    if (!ok) {
      message.error(t("common:copyFailed"));
      return;
    }
    setCopiedId(tpl.id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const applyExample = (example: (typeof EXAMPLE_BODIES_CHAT)[number] | (typeof EXAMPLE_BODIES_RESPONSES)[number]) => {
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
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${tpl.type === "responses" ? "text-purple-600 bg-purple-50 dark:bg-purple-900/20 dark:text-purple-300" : "text-blue-600 bg-blue-50 dark:bg-blue-900/20 dark:text-blue-300"}`}>
                        {tpl.type === "responses" ? t("rtTypeResponses") : t("rtTypeChat")}
                      </span>
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
          <Form form={form} layout="vertical" initialValues={{ type: "chat", models: ["*"], enabled: true }}>
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
              <Form.Item name="type" label={t("rtTypeLabel")} extra={t("rtTypeExtra")} className="flex-1" rules={[{ required: true }]}>
                <Select
                  options={[
                    { value: "chat", label: t("rtTypeChat") },
                    { value: "responses", label: t("rtTypeResponses") },
                  ]}
                />
              </Form.Item>
              <Form.Item name="enabled" label={t("rtEnabled")} valuePropName="checked">
                <Switch />
              </Form.Item>
            </div>

            <Form.Item name="models" label={t("rtModelsLabel")} extra={t("rtModelsExtra")}>
              <Select
                mode="tags"
                placeholder={t("rtModelsPlaceholder")}
                tokenSeparators={[","]}
              />
            </Form.Item>

            {!editingTemplate && (
              <div className="mb-3">
                <p className="text-xs text-zinc-400 mb-2">{t("rtExamplesTitle")}</p>
                <div className="flex flex-wrap gap-2">
                  {(typeWatch === "responses" ? EXAMPLE_BODIES_RESPONSES : EXAMPLE_BODIES_CHAT).map((ex) => (
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
