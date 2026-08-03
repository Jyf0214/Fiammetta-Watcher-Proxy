"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";
import { Form, message } from "antd";
import Switch from "@/components/ui/Switch";
import {
  PlatformList,
  BrandAvatar,
  StatusDot,
  type Platform,
} from "@/components/platform/PlatformList";
import { PlatformConfigForm } from "@/components/platform/PlatformConfigForm";
import { ModelsPanel } from "@/components/platform/ModelsPanel";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import AdminLayout from "@/components/AdminLayout";
import {
  parseNamedKeys,
  parseForwardHeaders,
  type ModelItem,
  type NamedApiKey,
} from "@/lib/platform";

export default function PlatformDetailPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const rawId = router.query.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  const isNew = id === "new";

  const [form] = Form.useForm();
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(!isNew);
  const [namedKeys, setNamedKeys] = useState<NamedApiKey[]>([{ name: "密钥1", key: "" }]);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toggling, setToggling] = useState(false);

  // 模型状态
  const [models, setModels] = useState<ModelItem[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [newModelId, setNewModelId] = useState("");
  const [togglingAll, setTogglingAll] = useState(false);
  const [togglingModelId, setTogglingModelId] = useState<string | null>(null);

  // id 变化时重置详情状态（渲染期调整，避免 effect 内同步 setState，防止旧平台数据串写）
  const [prevId, setPrevId] = useState(id);
  if (prevId !== id) {
    setPrevId(id);
    setPlatform(null);
    setModels([]);
  }

  // ---------- 数据加载 ----------
  const fetchList = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/admin/platforms", { signal });
      const data = (await res.json()) as Record<string, any>;
      if (data.success && Array.isArray(data.data)) setPlatforms(data.data);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      message.error(t("common.error"));
    } finally {
      if (!signal?.aborted) setListLoading(false);
    }
  }, [t]);

  const fetchModels = useCallback(async (platformId: string, signal?: AbortSignal) => {
    setModelsLoading(true);
    try {
      const res = await fetch(`/api/admin/platforms/${platformId}/models`, { signal });
      const data = (await res.json()) as Record<string, any>;
      if (data.success) setModels(data.data || []);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      message.error(t("common.error"));
    } finally {
      if (!signal?.aborted) setModelsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    const { signal } = controller;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async 数据获取在 await 后 setState，compiler lint 误报（facebook/react#34905）
    fetchList(signal);
    if (isNew) {
      setDetailLoading(false);
      form.resetFields();
      form.setFieldsValue({ type: "openai", priority: 0, weight: 1 });
      setNamedKeys([{ name: "密钥1", key: "" }]);
      return () => controller.abort();
    }
    setDetailLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/admin/platforms/${id}`, { signal });
        const data = (await res.json()) as Record<string, any>;
        if (data.success && data.data) {
          const p = data.data as Platform;
          setPlatform(p);
          form.setFieldsValue({ ...p, forwardHeaders: parseForwardHeaders(p.forwardHeaders) });
          const parsed = parseNamedKeys(p);
          setNamedKeys(parsed.length > 0 ? parsed : [{ name: "密钥1", key: "" }]);
          fetchModels(id, signal);
        } else {
          if (!signal.aborted) message.error(data.error || t("common.error"));
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        message.error(t("common.error"));
      } finally {
        if (!signal.aborted) setDetailLoading(false);
      }
    })();
    return () => controller.abort();
  }, [id, fetchList, fetchModels, form, isNew, t]);

  // ---------- 密钥编辑 ----------
  const addNamedKey = () => {
    const names = namedKeys.map((k) => k.name);
    let i = 1;
    while (names.includes(`密钥${i}`)) i++;
    setNamedKeys([...namedKeys, { name: `密钥${i}`, key: "" }]);
  };

  const removeNamedKey = (index: number) => {
    if (namedKeys.length <= 1) {
      message.warning("至少保留一个密钥");
      return;
    }
    setNamedKeys(namedKeys.filter((_, i) => i !== index));
  };

  const updateKeyName = (index: number, name: string) => {
    const keys = [...namedKeys];
    keys[index] = { ...keys[index], name };
    setNamedKeys(keys);
  };

  const updateKeyValue = (index: number, key: string) => {
    const keys = [...namedKeys];
    keys[index] = { ...keys[index], key };
    setNamedKeys(keys);
  };

  const copyKeyValue = (key: string) => {
    navigator.clipboard
      .writeText(key)
      .then(() => message.success("已复制到剪贴板"))
      .catch(() => message.error("复制失败"));
  };

  const handleToggleWhitelist = (index: number) => {
    const next = [...namedKeys];
    const newState = !next[index].whitelisted;
    next[index] = { ...next[index], whitelisted: newState };
    setNamedKeys(next);
    message.info(newState ? "已加入白名单（429 时不封禁）" : "已移出白名单");
  };

  // ---------- 保存 / 删除 / 启停 ----------
  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      const validKeys = namedKeys.filter((k) => k.key && k.key.trim());
      if (validKeys.length === 0 && isNew) {
        message.error("请至少填写一个 API 密钥");
        return;
      }
      setSubmitting(true);
      if (validKeys.length > 0) {
        values.apiKeys = JSON.stringify(
          validKeys.map((k) => ({
            name: k.name,
            key: k.key,
            ...(k.whitelisted ? { whitelisted: true } : {}),
          }))
        );
      }
      if (typeof values.forwardHeaders === "string") {
        const lines = values.forwardHeaders.split("\n").map((l: string) => l.trim()).filter(Boolean);
        values.forwardHeaders = lines.length > 0 ? JSON.stringify(lines) : "";
      }
      const url = isNew ? "/api/admin/platforms" : `/api/admin/platforms/${id}`;
      const method = isNew ? "POST" : "PUT";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const data = (await res.json()) as Record<string, any>;
      if (data.success) {
        message.success(data.message);
        if (isNew) {
          router.push("/admin/platforms");
          return;
        }
        const updated: Platform = {
          ...(platform as Platform),
          ...values,
          apiKeys: values.apiKeys ?? (platform as Platform).apiKeys,
        };
        setPlatform(updated);
        setPlatforms((prev) => prev.map((p) => (p.id === id ? updated : p)));
      } else {
        message.error(data.error || t("common.error"));
      }
    } catch (err) {
      if (err && typeof err === "object" && "errorFields" in err) return;
      message.error(t("common.error"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!id || isNew) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/admin/platforms/${id}`, { method: "DELETE" });
      const data = (await res.json()) as Record<string, any>;
      if (data.success) {
        message.success(t("platform.delete_success") || "删除成功");
        router.push("/admin/platforms");
      } else {
        message.error(data.error || t("common.error"));
      }
    } catch {
      message.error(t("common.error"));
    } finally {
      setDeleting(false);
    }
  };

  const handleToggle = async (enabled: boolean) => {
    if (!id || isNew) return;
    setToggling(true);
    try {
      const res = await fetch(`/api/admin/platforms/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = (await res.json()) as Record<string, any>;
      if (data.success) {
        setPlatform((prev) => (prev ? { ...prev, enabled } : prev));
        setPlatforms((prev) => prev.map((p) => (p.id === id ? { ...p, enabled } : p)));
      } else {
        message.error(data.error || t("common.error"));
      }
    } catch {
      message.error(t("common.error"));
    } finally {
      setToggling(false);
    }
  };

  // ---------- 模型操作 ----------
  const handleRefreshModels = async () => {
    if (!id || isNew) return;
    setRefreshing(true);
    try {
      const res = await fetch(`/api/admin/platforms/${id}/models`, { method: "PUT" });
      const data = (await res.json()) as Record<string, any>;
      if (data.success) {
        message.success(data.message);
        fetchModels(id);
      } else {
        message.error(data.error || t("common.error"));
      }
    } catch {
      message.error(t("common.error"));
    } finally {
      setRefreshing(false);
    }
  };

  const handleAddModel = async () => {
    if (!id || isNew || !newModelId.trim()) return;
    try {
      const res = await fetch(`/api/admin/platforms/${id}/models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId: newModelId.trim() }),
      });
      const data = (await res.json()) as Record<string, any>;
      if (data.success) {
        message.success(data.message);
        setNewModelId("");
        fetchModels(id);
      } else {
        message.error(data.error || t("common.error"));
      }
    } catch {
      message.error(t("common.error"));
    }
  };

  const handleDeleteModel = async (modelId: string) => {
    if (!id || isNew) return;
    try {
      const res = await fetch(
        `/api/admin/platforms/${id}/models?modelId=${encodeURIComponent(modelId)}`,
        { method: "DELETE" }
      );
      const data = (await res.json()) as Record<string, any>;
      if (data.success) fetchModels(id);
      else message.error(data.error || t("error.delete_failed"));
    } catch {
      message.error(t("common.error"));
    }
  };

  const handleToggleModel = async (modelId: string, enabled: boolean) => {
    if (!id || isNew) return;
    setTogglingModelId(modelId);
    try {
      const res = await fetch(`/api/admin/platforms/${id}/models`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId, enabled }),
      });
      const data = (await res.json()) as Record<string, any>;
      if (data.success) {
        setModels((prev) => prev.map((m) => (m.modelId === modelId ? { ...m, enabled } : m)));
      } else {
        message.error(data.error || t("common.error"));
      }
    } catch {
      message.error(t("common.error"));
    } finally {
      setTogglingModelId(null);
    }
  };

  const handleToggleAll = async (enabled: boolean) => {
    if (!id || isNew) return;
    setTogglingAll(true);
    try {
      const res = await fetch(`/api/admin/platforms/${id}/models`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = (await res.json()) as Record<string, any>;
      if (data.success) {
        setModels((prev) => prev.map((m) => ({ ...m, enabled })));
      } else {
        message.error(data.error || t("common.error"));
      }
    } catch {
      message.error(t("common.error"));
    } finally {
      setTogglingAll(false);
    }
  };

  // ---------- 渲染 ----------
  const configForm = (
    <PlatformConfigForm
      form={form}
      editing={platform}
      namedKeys={namedKeys}
      onAddKey={addNamedKey}
      onRemoveKey={removeNamedKey}
      onUpdateKeyName={updateKeyName}
      onUpdateKeyValue={updateKeyValue}
      onCopyKey={copyKeyValue}
      onToggleWhitelist={handleToggleWhitelist}
      onSubmit={handleSubmit}
      submitting={submitting}
      onDelete={handleDelete}
      deleting={deleting}
      onToggle={handleToggle}
      toggling={toggling}
    />
  );

  return (
    <AdminLayout>
      <div className="flex flex-col lg:flex-row h-full">
        {/* 左侧：桌面端平台列表栏 */}
        <div className="hidden lg:block w-[340px] shrink-0 border-r border-zinc-100 dark:border-zinc-800 bg-white dark:bg-zinc-900 rounded-2xl overflow-hidden mr-6">
          <PlatformList
            platforms={platforms}
            loading={listLoading}
            activeId={typeof id === "string" ? id : undefined}
            className="h-[calc(100vh-100px)] overflow-y-auto"
          />
        </div>

        {/* 右侧：主内容区 */}
        <div className="flex-1 min-w-0 relative">

          {/* 移动端返回条（sticky 吸附在 Header 下方 64px） */}
          <div className="lg:hidden sticky top-16 left-0 right-0 z-40 bg-white/95 dark:bg-zinc-900/95 backdrop-blur px-4 py-2.5 flex items-center justify-between border-b border-zinc-200/80 dark:border-zinc-800">
            <div className="flex items-center gap-2.5 min-w-0 flex-1 mr-2">
              <button
                onClick={() => router.push("/admin/platforms")}
                className="p-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 shrink-0"
                aria-label={t("platform.back")}
              >
                <ArrowLeft size={18} />
              </button>
              {platform && !isNew && (
                <div className="shrink-0">
                  <BrandAvatar name={platform.name} type={platform.type} size="sm" />
                </div>
              )}
              <span className="text-[15px] font-bold text-zinc-900 dark:text-zinc-100 truncate">
                {isNew ? t("platform.create_platform") : platform?.name ?? "…"}
              </span>
            </div>

            {platform && !isNew && (
              <div className="flex items-center gap-2 shrink-0">
                <StatusDot status={platform.status} enabled={platform.enabled} />
                <Switch checked={platform.enabled} loading={toggling} onChange={handleToggle} />
              </div>
            )}
          </div>

          {/* 详情主体 — 桌面端无额外顶部间距；移动端返回条 sticky 在文档流内占位，仅保留少量呼吸间距 */}
          <div className="w-full max-w-2xl mx-auto pt-4 lg:pt-0 pb-10">
            {detailLoading ? (
              <div className="py-24 text-center text-zinc-300 dark:text-zinc-600">
                <RefreshCw size={28} className="inline animate-spin" />
              </div>
            ) : isNew ? (
              <>
                <h1 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 mb-5">
                  {t("platform.create_platform")}
                </h1>
                {configForm}
              </>
            ) : platform ? (
              <div className="flex flex-col gap-8">
                {/* 配置表单（上）— 卡片头部含品牌/名称/状态/启停开关 */}
                {configForm}

                {/* 模型列表（下）— 对照 ProviderDetail 的 ModelList */}
                <div className="border-t border-zinc-100 dark:border-zinc-800 pt-6">
                  <ModelsPanel
                    models={models}
                    loading={modelsLoading}
                    refreshing={refreshing}
                    newModelId={newModelId}
                    onNewModelIdChange={setNewModelId}
                    onAddModel={handleAddModel}
                    onRefreshModels={handleRefreshModels}
                    onDeleteModel={handleDeleteModel}
                    onToggleModel={handleToggleModel}
                    onToggleAll={handleToggleAll}
                    togglingAll={togglingAll}
                    togglingModelId={togglingModelId}
                  />
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}