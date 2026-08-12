import { useState, useEffect, useLayoutEffect, useCallback } from "react";
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
import { useApi, UNAUTHORIZED_MESSAGE } from "@/hooks/use-api";
import AdminLayout from "@/components/AdminLayout";
import {
  parseNamedKeys,
  parseForwardHeaders,
  type ModelItem,
  type NamedApiKey,
} from "@/lib/platform";

export default function PlatformDetailPage() {
  const { t } = useTranslation("platform");
  const router = useRouter();
  const rawId = router.query.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  const isNew = id === "new";

  const [form] = Form.useForm();
  const defaultKeyName = useCallback((i: number) => `${t("keyNamePrefix")}${i}`, [t]);
  const [namedKeys, setNamedKeys] = useState<NamedApiKey[]>([{ name: defaultKeyName(1), key: "" }]);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toggling, setToggling] = useState(false);

  // 模型操作状态
  const [refreshing, setRefreshing] = useState(false);
  const [newModelId, setNewModelId] = useState("");
  const [togglingAll, setTogglingAll] = useState(false);
  const [togglingModelId, setTogglingModelId] = useState<string | null>(null);

  // ===== 数据层（SWR）：列表 / 详情 / 模型三路并行，key 含 id 变化时自动重新请求 =====
  // 列表 key 与平台列表页（/admin/platforms）共享同一缓存：详情页左侧栏与列表页数据自动一致
  const listKey = "/api/admin/platforms";
  // 详情与模型仅在非新建模式下请求（key 为 null 时不发请求）
  const detailKey = !id || isNew ? null : `/api/admin/platforms/${id}`;
  const modelsKey = !id || isNew ? null : `/api/admin/platforms/${id}/models`;

  const {
    data: platforms,
    error: listError,
    isValidating: listLoading,
    mutate: mutateList,
  } = useApi<Platform[]>(listKey);

  const {
    data: platform,
    error: detailError,
    isLoading: detailLoading,
    mutate: mutateDetail,
  } = useApi<Platform | null>(detailKey);

  const {
    data: models,
    error: modelsError,
    isValidating: modelsLoading,
    mutate: mutateModels,
  } = useApi<ModelItem[]>(modelsKey);

  // 请求失败提示（401 已由 fetcher 统一提示并跳转登录页）
  useEffect(() => {
    if (listError && listError.message !== UNAUTHORIZED_MESSAGE) {
      message.error(t("common:error"));
    }
  }, [listError, t]);
  useEffect(() => {
    if (detailError && detailError.message !== UNAUTHORIZED_MESSAGE) {
      message.error(t("common:error"));
    }
  }, [detailError, t]);
  useEffect(() => {
    if (modelsError && modelsError.message !== UNAUTHORIZED_MESSAGE) {
      message.error(t("common:error"));
    }
  }, [modelsError, t]);

  // id 变化时重置表单同步标记（渲染期调整，避免 effect 内同步 setState，防止旧平台数据串写）
  const [prevId, setPrevId] = useState(id);
  const [syncedForId, setSyncedForId] = useState<string | null>(null);
  const [syncedForNew, setSyncedForNew] = useState(false);
  if (prevId !== id) {
    setPrevId(id);
    setSyncedForId(null);
    setSyncedForNew(false);
  }

  // 新增模式：进入时初始化默认表单值（仅一次，重复渲染不覆盖）
  useEffect(() => {
    if (!isNew || syncedForNew) return;
    setSyncedForNew(true);
    form.resetFields();
    form.setFieldsValue({ type: "openai", priority: 0, weight: 1 });
    setNamedKeys([{ name: defaultKeyName(1), key: "" }]);
  }, [isNew, syncedForNew, form, defaultKeyName]);

  // 详情加载完成：将平台配置同步进表单（同一 id 只同步一次，之后的重新验证不覆盖用户编辑）
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useLayoutEffect(() => {
    if (isNew || !platform || !id) return;
    if (syncedForId === id) return;
    setSyncedForId(id);
    form.setFieldsValue({ ...platform, forwardHeaders: parseForwardHeaders(platform.forwardHeaders) });
    const parsed = parseNamedKeys(platform, t("keyNamePrefix"));
    setNamedKeys(parsed.length > 0 ? parsed : [{ name: defaultKeyName(1), key: "" }]);
  }, [platform, id, isNew, syncedForId, form, t, defaultKeyName]);

  // ---------- 密钥编辑 ----------
  const addNamedKey = () => {
    const names = namedKeys.map((k) => k.name);
    let i = 1;
    while (names.includes(defaultKeyName(i))) i++;
    setNamedKeys([...namedKeys, { name: defaultKeyName(i), key: "" }]);
  };

  const removeNamedKey = (index: number) => {
    if (namedKeys.length <= 1) {
      message.warning(t("atLeastOneKey"));
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
      .then(() => message.success(t("common:copied")))
      .catch(() => message.error(t("common:copyFailed")));
  };

  const handleToggleWhitelist = (index: number) => {
    const next = [...namedKeys];
    const newState = !next[index].whitelisted;
    next[index] = { ...next[index], whitelisted: newState };
    setNamedKeys(next);
    message.info(newState ? t("whitelistAdded") : t("whitelistRemoved"));
  };

  // ---------- 保存 / 删除 / 启停 ----------
  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      const validKeys = namedKeys.filter((k) => k.key && k.key.trim());
      if (validKeys.length === 0 && isNew) {
        message.error(t("keyRequired"));
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
          // 新建成功后列表缓存需刷新，跳回列表页时展示最新数据
          mutateList();
          router.push("/admin/platforms");
          return;
        }
        // 重新拉取详情与列表（表单已同步过该 id，不会被覆盖）
        mutateDetail();
        mutateList();
      } else {
        message.error(data.error || t("common:error"));
      }
    } catch (err) {
      if (err && typeof err === "object" && "errorFields" in err) return;
      message.error(t("common:error"));
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
        message.success(t("deleteSuccess"));
        // 删除后刷新列表缓存，跳回列表页时不显示已删平台
        mutateList();
        router.push("/admin/platforms");
      } else {
        message.error(data.error || t("common:error"));
      }
    } catch {
      message.error(t("common:error"));
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
        mutateDetail();
        mutateList();
      } else {
        message.error(data.error || t("common:error"));
      }
    } catch {
      message.error(t("common:error"));
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
        mutateModels();
      } else {
        message.error(data.error || t("common:error"));
      }
    } catch {
      message.error(t("common:error"));
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
        mutateModels();
      } else {
        message.error(data.error || t("common:error"));
      }
    } catch {
      message.error(t("common:error"));
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
      if (data.success) mutateModels();
      else message.error(data.error || t("deleteFailed"));
    } catch {
      message.error(t("common:error"));
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
        // 本地更新缓存（不发请求），与开关即时反馈一致
        mutateModels(
          (prev) => prev?.map((m) => (m.modelId === modelId ? { ...m, enabled } : m)),
          { revalidate: false }
        );
      } else {
        message.error(data.error || t("common:error"));
      }
    } catch {
      message.error(t("common:error"));
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
        mutateModels(
          (prev) => prev?.map((m) => ({ ...m, enabled })),
          { revalidate: false }
        );
      } else {
        message.error(data.error || t("common:error"));
      }
    } catch {
      message.error(t("common:error"));
    } finally {
      setTogglingAll(false);
    }
  };

  // ---------- 渲染 ----------
  const configForm = (
    <PlatformConfigForm
      form={form}
      editing={platform ?? null}
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
            platforms={platforms ?? []}
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
                aria-label={t("back")}
              >
                <ArrowLeft size={18} />
              </button>
              {platform && !isNew && (
                <div className="shrink-0">
                  <BrandAvatar name={platform.name} type={platform.type} size="sm" />
                </div>
              )}
              <span className="text-[15px] font-bold text-zinc-900 dark:text-zinc-100 truncate">
                {isNew ? t("createPlatform") : platform?.name ?? "…"}
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
                  {t("createPlatform")}
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
                    models={models ?? []}
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