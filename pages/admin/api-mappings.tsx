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
import { FileText, Plus, Pencil, Trash2, ArrowRight } from "lucide-react";
import { useApi, UNAUTHORIZED_MESSAGE } from "@/hooks/use-api";
import AdminLayout from "@/components/AdminLayout";

interface ApiMapping {
  id: string;
  name: string;
  description: string;
  pattern: string;
  targetModel: string;
  sourceApi: "chat" | "responses";
  targetApi: "chat" | "responses";
  platformId?: string | null;
  enabled: boolean;
}

export default function ApiMappingsPage() {
  const { t } = useTranslation("system");
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ApiMapping | null>(null);
  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [form] = Form.useForm();

  const { data: mappings, error, isLoading, mutate } = useApi<ApiMapping[]>("/api/admin/api-mappings");

  useEffect(() => {
    if (error && error.message !== UNAUTHORIZED_MESSAGE) {
      message.error(t("common:error"));
    }
  }, [error, t]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      sourceApi: "chat",
      targetApi: "responses",
      enabled: true,
      pattern: "old-model*",
      targetModel: "gpt-5",
    });
    setModalOpen(true);
  };

  const openEdit = (m: ApiMapping) => {
    setEditing(m);
    form.setFieldsValue({
      name: m.name,
      description: m.description,
      pattern: m.pattern,
      targetModel: m.targetModel,
      sourceApi: m.sourceApi,
      targetApi: m.targetApi,
      platformId: m.platformId || undefined,
      enabled: m.enabled,
    });
    setModalOpen(true);
  };

  const handleSave = async () => {
    let values: any;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/admin/api-mappings", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(editing ? { id: editing.id } : {}),
          name: values.name,
          description: values.description,
          pattern: values.pattern,
          targetModel: values.targetModel,
          sourceApi: values.sourceApi,
          targetApi: values.targetApi,
          platformId: values.platformId || null,
          enabled: values.enabled,
        }),
      });
      const data = await res.json() as any;
      if (data.success) {
        message.success(editing ? t("apiMappingUpdateSuccess") : t("apiMappingCreateSuccess"));
        setModalOpen(false);
        mutate();
      } else {
        message.error(typeof data.error === "string" ? data.error : t("common:error"));
      }
    } catch {
      message.error(t("common:networkError"));
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (m: ApiMapping) => {
    setTogglingId(m.id);
    try {
      const res = await fetch("/api/admin/api-mappings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: m.id, enabled: !m.enabled }),
      });
      const data = await res.json() as any;
      if (data.success) mutate();
      else message.error(data.error);
    } catch {
      message.error(t("common:networkError"));
    } finally {
      setTogglingId(null);
    }
  };

  const handleDelete = (m: ApiMapping) => {
    Modal.confirm({
      title: t("apiMappingDeleteConfirm"),
      okText: t("common:confirm"),
      cancelText: t("common:cancel"),
      okType: "danger",
      onOk: async () => {
        try {
          const res = await fetch(`/api/admin/api-mappings?id=${m.id}`, { method: "DELETE" });
          const data = await res.json() as any;
          if (data.success) {
            message.success(t("apiMappingDeleteSuccess"));
            mutate();
          } else message.error(data.error);
        } catch {
          message.error(t("common:error"));
        }
      },
    });
  };

  if (isLoading && !mappings) {
    return (
      <AdminLayout>
        <PageContainer>
          <AsyncBoundary isLoading error={null}><></></AsyncBoundary>
        </PageContainer>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout>
      <PageContainer>
        <PageHeader
          icon={<FileText size={20} className="text-zinc-500 dark:text-zinc-400" />}
          title={t("apiMappingsTitle")}
          description={t("apiMappingsDesc")}
          extra={
            <Button variant="primary" size="sm" onClick={openCreate} icon={<Plus size={14} />}>
              {t("apiMappingAdd")}
            </Button>
          }
        />

        {(mappings ?? []).length === 0 ? (
          <ProCard>
            <EmptyState
              icon={<FileText className="w-12 h-12" />}
              title={t("apiMappingNoData")}
              action={
                <Button variant="primary" size="sm" onClick={openCreate} icon={<Plus size={14} />}>
                  {t("apiMappingAdd")}
                </Button>
              }
            />
          </ProCard>
        ) : (
          <div className="space-y-3">
            {(mappings ?? []).map((m) => (
              <ProCard key={m.id}>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">{m.name}</h3>
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500">
                        {m.pattern} <ArrowRight size={10} className="inline mx-1" /> {m.targetModel}
                      </span>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${m.sourceApi === "responses" ? "bg-purple-50 text-purple-600 dark:bg-purple-900/20" : "bg-blue-50 text-blue-600 dark:bg-blue-900/20"}`}>
                        {m.sourceApi}
                      </span>
                      <ArrowRight size={12} className="text-zinc-400" />
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${m.targetApi === "responses" ? "bg-purple-50 text-purple-600 dark:bg-purple-900/20" : "bg-blue-50 text-blue-600 dark:bg-blue-900/20"}`}>
                        {m.targetApi}
                      </span>
                      {!m.enabled && <span className="text-[10px] font-bold text-zinc-400">{t("common:disabled")}</span>}
                    </div>
                    {m.description && <p className="text-xs text-zinc-400 mb-1">{m.description}</p>}
                    <p className="text-xs text-zinc-500 font-mono">{m.pattern} → {m.targetModel} {m.platformId ? `(${m.platformId})` : "(all platforms)"}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Switch checked={m.enabled} loading={togglingId === m.id} onChange={() => handleToggle(m)} />
                    <button onClick={() => openEdit(m)} className="p-2 rounded-lg text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-700 transition-colors"><Pencil size={16} /></button>
                    <button onClick={() => handleDelete(m)} className="p-2 rounded-lg text-zinc-400 hover:bg-red-50 hover:text-red-500 transition-colors"><Trash2 size={16} /></button>
                  </div>
                </div>
              </ProCard>
            ))}
          </div>
        )}

        <Modal
          title={editing ? t("common:edit") : t("apiMappingAdd")}
          open={modalOpen}
          onCancel={() => setModalOpen(false)}
          onOk={handleSave}
          confirmLoading={saving}
          okText={t("common:save")}
          cancelText={t("common:cancel")}
          width={640}
          destroyOnClose
        >
          <Form form={form} layout="vertical" initialValues={{ sourceApi: "chat", targetApi: "responses", enabled: true }}>
            <Form.Item name="name" label={t("apiMappingName")} rules={[{ required: true, message: t("validation:required") }]}>
              <Input placeholder={t("apiMappingNamePlaceholder")} />
            </Form.Item>
            <Form.Item name="description" label={t("apiMappingDescLabel")}>
              <Input.TextArea rows={2} placeholder={t("apiMappingDescPlaceholder")} />
            </Form.Item>
            <div className="flex gap-4">
              <Form.Item name="pattern" label={t("apiMappingPattern")} extra={t("apiMappingPatternExtra")} className="flex-1" rules={[{ required: true, message: t("validation:required") }]}>
                <Input placeholder="old-model*" />
              </Form.Item>
              <Form.Item name="targetModel" label={t("apiMappingTargetModel")} className="flex-1" rules={[{ required: true, message: t("validation:required") }]}>
                <Input placeholder="gpt-5" />
              </Form.Item>
            </div>
            <div className="flex gap-4">
              <Form.Item name="sourceApi" label={t("apiMappingSourceApi")} className="flex-1" rules={[{ required: true }]}>
                <Select options={[{ value: "chat", label: "Chat Completions (/v1/chat/completions)" }, { value: "responses", label: "Responses API (/v1/responses)" }]} />
              </Form.Item>
              <Form.Item name="targetApi" label={t("apiMappingTargetApi")} className="flex-1" rules={[{ required: true }]}>
                <Select options={[{ value: "chat", label: "Chat Completions" }, { value: "responses", label: "Responses API" }]} />
              </Form.Item>
            </div>
            <Form.Item name="platformId" label={t("apiMappingPlatformId")} extra={t("apiMappingPlatformIdExtra")}>
              <Input placeholder={t("apiMappingPlatformIdPlaceholder")} />
            </Form.Item>
            <Form.Item name="enabled" label={t("common:status")} valuePropName="checked">
              <Switch />
            </Form.Item>
            <div className="bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800 rounded-lg p-3 text-xs text-amber-700 dark:text-amber-300">
              {t("apiMappingHint")}
            </div>
          </Form>
        </Modal>
      </PageContainer>
    </AdminLayout>
  );
}
