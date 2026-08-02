"use client";

import { useState, useEffect } from "react";
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

/**
 * 平台详情/新建页（独立路由）
 * - 桌面端（≥1024px）：左侧平台列表栏 + 右侧设置面板（三栏布局）
 * - 移动端：返回条 + 全屏设置页
 * - 支持 /admin/platforms/new 新建模式
 */
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
  const [tab, setTab] = useState<"config" | "models">("config");

  // 模型状态
  const [models, setModels] = useState<ModelItem[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [newModelId, setNewModelId] = useState("");
  const [togglingAll, setTogglingAll] = useState(false);
  const [togglingModelId, setTogglingModelId] = useState<string | null>(null);

  // ---------- 数据加载 ----------
  const fetchList = async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/admin/platforms", { signal });
      const data = await res.json() as Record<string, any>;
      if (data.success && Array.isArray(data.data)) setPlatforms(data.data);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      message.error(t("common.error"));
    } finally {
      if (!signal?.aborted) setListLoading(false);
    }
  };

  const fetchModels = async (platformId: string, signal?: AbortSignal) => {
    setModelsLoading(true);
    try {
      const res = await fetch(`/api/admin/platforms/${platformId}/models`, { signal });
      const data = await res.json() as Record<string, any>;
      if (data.success) setModels(data.data || []);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      message.error(t("common.error"));
    } finally {
      if (!signal?.aborted) setModelsLoading(false);
    }
  };

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    const { signal } = controller;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPlatform(null);
    setModels([]);
    setTab("config");
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
        const data = await res.json() as Record<string, any>;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // ---------- 密钥编辑 ----------
  const addNamedKey = () => {
    const names = namedKeys.map((k) => k.name);
    let i = 1;
    while (names.includes(`密钥${i}`)) i++;
    setNamedKeys([...namedKeys, { name: `密钥${i}`, key: "" }]);
  };

  const removeNamedKey = (index: number) => {
    if (namedKeys.length <= 1) { message.warning("至少保留一个密钥"); return; }
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
        values.apiKeys = JSON.stringify(validKeys.map((k) => ({
          name: k.name,
          key: k.key,
          ...(k.whitelisted ? { whitelisted: true } : {}),
        })));
      }
      if (typeof values.forwardHeaders === "string") {
        const lines = values.forwardHeaders.split("\n").map((l: string) => l.trim()).filter(Boolean);
        values.forwardHeaders = lines.length > 0 ? JSON.stringify(lines) : "";
      }
      const url = isNew ? "/api/admin/platforms" : `/api/admin/platforms/${id}`;
      const method = isNew ? "POST" : "PUT";
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
      const data = await res.json() as Record<string, any>;
      if (data.success) {
        message.success(data.message);
        if (isNew) {
          router.push("/admin/platforms");
          return;
        }
        // 就地更新当前平台与列表栏
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
      const data = await res.json() as Record<string, any>;
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
      const data = await res.json() as Record<string, any>;
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
      const data = await res.json() as Record<string, any>;
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
      const data = await res.json() as Record<string, any>;
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
      const res = await fetch(`/api/admin/platforms/${id}/models?modelId=${encodeURIComponent(modelId)}`, { method: "DELETE" });
      const data = await res.json() as Record<string, any>;
      if (data.success) fetchModels(id);
      else message.error(data.error || t("common.error"));
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
      const data = await res.json() as Record<string, any>;
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
      const data = await res.json() as Record<string, any>;
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
  const statusLabel = !platform
    ? ""
    : platform.status === "healthy"
      ? t("platform.status_healthy")
      : platform.status === "degraded"
        ? t("platform.status_degraded")
        : t("platform.status_down");

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
    />
  );

  return (
    <AdminLayout>
      {/* 移动端 -mx-4/-my-4 抵消 main 的 p-4，返回条从顶栏正下方开始，消除顶部空白 */}
      <div className="-mx-4 -my-4 md:-mx-6 md:-my-6 lg:h-[calc(100vh-48px)] lg:overflow-hidden">
        <div className="lg:flex lg:h-full">
          {/* 桌面端左侧平台列表栏 */}
          <div className="hidden lg:block w-[340px] shrink-0 border-r border-zinc-100 dark:border-zinc-800 bg-white dark:bg-zinc-900">
            <PlatformList
              platforms={platforms}
              loading={listLoading}
              activeId={typeof id === "string" ? id : undefined}
              className="h-full"
            />
          </div>

          {/* 详情区 */}
          <div className="flex-1 min-w-0 lg:overflow-y-auto">
            {/* 移动端顶部导航：返回 + 品牌 + 名称 + 状态 + 启停（整合原头部，滚动不再遮挡内容） */}
            <div className="lg:hidden sticky top-12 z-20 bg-white dark:bg-zinc-900 px-3 py-2 flex items-center gap-2 border-b border-zinc-100 dark:border-zinc-800 shadow-sm">
              <button
                onClick={() => router.push("/admin/platforms")}
                className="p-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 shrink-0"
                aria-label={t("platform.back")}
              >
                <ArrowLeft size={18} />
              </button>
              {platform && !isNew && (
                <BrandAvatar name={platform.name} type={platform.type} size="md" />
              )}
              <span className="flex-1 min-w-0 text-sm font-bold text-zinc-900 dark:text-zinc-100 truncate">
                {isNew ? t("platform.create_platform") : (platform?.name ?? "…")}
              </span>
              {platform && !isNew && (
                <div className="flex items-center gap-2 shrink-0">
                  <StatusDot status={platform.status} enabled={platform.enabled} />
                  <Switch checked={platform.enabled} loading={toggling} onChange={handleToggle} />
                </div>
              )}
            </div>

            <div className="max-w-2xl mx-auto px-3 py-4 lg:px-10 lg:py-8">
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
                <>
                  {/* 桌面端头部：品牌 + 名称 + 状态 + 启停（移动端已整合进顶部导航，仅 lg+ 渲染避免重复） */}
                  <div className="hidden lg:flex items-center gap-3 mb-5">
                    <BrandAvatar name={platform.name} type={platform.type} size="lg" />
                    <div className="flex-1 min-w-0">
                      <h1 className="text-base font-bold text-zinc-900 dark:text-zinc-100 truncate">
                        {platform.name}
                      </h1>
                      <div className="flex items-center gap-1.5 mt-1">
                        <StatusDot status={platform.status} enabled={platform.enabled} />
                        <span className="text-[11px] text-zinc-400">
                          {platform.enabled ? statusLabel : t("common.disable")}
                        </span>
                      </div>
                    </div>
                    <div className="shrink-0">
                      <Switch checked={platform.enabled} loading={toggling} onChange={handleToggle} />
                    </div>
                  </div>

                  {/* Tab 切换 */}
                  <div className="flex gap-1 p-1 bg-zinc-100 dark:bg-zinc-800 rounded-xl mb-4" role="tablist">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tab === "config"}
                      onClick={() => setTab("config")}
                      className={`flex-1 px-3 py-2 text-sm rounded-lg transition-all ${
                        tab === "config"
                          ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 font-semibold shadow-sm"
                          : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                      }`}
                    >
                      {t("platform.config_tab")}
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tab === "models"}
                      onClick={() => setTab("models")}
                      className={`flex-1 px-3 py-2 text-sm rounded-lg transition-all ${
                        tab === "models"
                          ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 font-semibold shadow-sm"
                          : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                      }`}
                    >
                      {t("platform.models")} ({models.length})
                    </button>
                  </div>

                  {tab === "config" ? (
                    configForm
                  ) : (
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
                  )}
                </>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
