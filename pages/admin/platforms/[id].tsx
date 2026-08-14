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
import { ModelsPanel, type TestResult } from "@/components/platform/ModelsPanel";
import { ArrowLeft, RefreshCw, Zap, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { useApi, UNAUTHORIZED_MESSAGE } from "@/hooks/use-api";
import AdminLayout from "@/components/AdminLayout";
import { SurfaceSkeleton } from "@/components/ui/SurfaceSkeleton";
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
  const [togglingKeyIndex, setTogglingKeyIndex] = useState<number | null>(null);
  const [unbanning, setUnbanning] = useState(false);
  const [infoModalOpen, setInfoModalOpen] = useState(false);

  // 模型操作状态
  const [refreshing, setRefreshing] = useState(false);
  const [newModelId, setNewModelId] = useState("");
  const [togglingAll, setTogglingAll] = useState(false);
  const [togglingModelId, setTogglingModelId] = useState<string | null>(null);

  // 模型测试状态
  const [testLoading, setTestLoading] = useState(false);
  const [testResults, setTestResults] = useState<TestResult[] | null>(null);

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
  useLayoutEffect(() => {
    if (!isNew || syncedForNew) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSyncedForNew(true);
    form.resetFields();
    form.setFieldsValue({ type: "openai", priority: 0, weight: 1 });
    setNamedKeys([{ name: defaultKeyName(1), key: "" }]);
  }, [isNew, syncedForNew, form, defaultKeyName]);

  // 详情加载完成：将平台配置同步进表单（同一 id 只同步一次，之后的重新验证不覆盖用户编辑）
  useLayoutEffect(() => {
    if (isNew || !platform || !id) return;
    if (syncedForId === id) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
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

  const batchAddNamedKeys = (keys: string[]) => {
    const existingKeySet = new Set(namedKeys.map((k) => k.key));
    const seen = new Set<string>();
    const names = namedKeys.map((k) => k.name);
    const newEntries: NamedApiKey[] = [];
    let i = 1;
    for (const key of keys) {
      // 排除与已有密钥重复、排除本次批量内重复
      if (existingKeySet.has(key) || seen.has(key)) continue;
      seen.add(key);
      while (names.includes(defaultKeyName(i))) i++;
      names.push(defaultKeyName(i));
      newEntries.push({ name: defaultKeyName(i), key });
      i++;
    }
    if (newEntries.length === 0) {
      message.warning(t("batchAddKeyAllDup"));
    } else {
      setNamedKeys([...namedKeys, ...newEntries]);
      if (newEntries.length < keys.length) {
        message.info(t("batchAddKeyPartialDup", { added: newEntries.length, total: keys.length }));
      }
    }
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

  const handleToggleKey = async (index: number, enabled: boolean) => {
    if (!id || isNew) return;
    const targetKey = namedKeys[index]?.key;
    if (!targetKey) return;
    setTogglingKeyIndex(index);
    try {
      const res = await fetch(`/api/admin/platforms/${id}/keys`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: targetKey, enabled }),
      });
      const data = (await res.json()) as Record<string, any>;
      if (data.success) {
        // 更新本地状态
        const next = [...namedKeys];
        next[index] = { ...next[index], enabled };
        if (enabled) next[index].errorCount = 0;
        setNamedKeys(next);
        message.success(data.message);
        mutateDetail();
        mutateList();
      } else {
        message.error(data.error || t("common:error"));
      }
    } catch {
      message.error(t("common:error"));
    } finally {
      setTogglingKeyIndex(null);
    }
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
          validKeys.map((k) => {
            const obj: Record<string, unknown> = { name: k.name, key: k.key };
            if (k.whitelisted) obj.whitelisted = true;
            if (k.enabled === false) obj.enabled = false;
            if (typeof k.errorCount === "number" && k.errorCount > 0) obj.errorCount = k.errorCount;
            return obj;
          })
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

  // ---------- 解禁（熔断恢复） ----------
  const handleUnban = async () => {
    if (!id || isNew) return;
    setUnbanning(true);
    try {
      const res = await fetch(`/api/admin/platforms/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "healthy", cooldownEnd: null }),
      });
      const data = (await res.json()) as Record<string, any>;
      if (data.success) {
        message.success(t("platformUnbanned"));
        mutateDetail();
        mutateList();
      } else {
        message.error(data.error || t("common:error"));
      }
    } catch {
      message.error(t("common:error"));
    } finally {
      setUnbanning(false);
    }
  };

  // ---------- 模型操作 ----------
  const handleTestModel = async (modelId: string) => {
    if (!id || isNew) return;
    setTestLoading(true);
    setTestResults(null);
    try {
      const res = await fetch(`/api/admin/platforms/${id}/test-model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId }),
      });
      const data = (await res.json()) as Record<string, any>;
      if (data.success) {
        setTestResults(data.data as TestResult[]);
      } else {
        message.error(data.error || t("common:error"));
      }
    } catch {
      message.error(t("common:error"));
    } finally {
      setTestLoading(false);
    }
  };

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
      onBatchAddKeys={batchAddNamedKeys}
      onRemoveKey={removeNamedKey}
      onUpdateKeyName={updateKeyName}
      onUpdateKeyValue={updateKeyValue}
      onCopyKey={copyKeyValue}
      onToggleWhitelist={handleToggleWhitelist}
      onToggleKey={handleToggleKey}
      onSubmit={handleSubmit}
      submitting={submitting}
      onDelete={handleDelete}
      deleting={deleting}
      onToggle={handleToggle}
      toggling={toggling}
      togglingKeyIndex={togglingKeyIndex}
      infoModalOpen={infoModalOpen}
      onInfoModalOpenChange={setInfoModalOpen}
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

        {/* 右侧：详情主体 */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          {/* 移动端返回条（sticky 吸顶 — 负边距抵消 AdminLayout p-4 实现完全吸顶+左右撑满） */}
          <div className="lg:hidden sticky top-0 z-40 bg-white/95 dark:bg-zinc-900/95 backdrop-blur -mx-4 -mt-4 px-4 py-2.5 flex items-center justify-between border-b border-zinc-200/80 dark:border-zinc-800">
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
                {platform.status === "down" && (
                  <button
                    type="button"
                    onClick={handleUnban}
                    disabled={unbanning}
                    className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    title={t("platformUnbanTip")}
                  >
                    <Zap size={12} />
                    <span className="hidden sm:inline">{unbanning ? t("common:loading") : t("platformUnban")}</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setInfoModalOpen(true)}
                  className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:text-zinc-200 dark:hover:bg-zinc-800 transition-colors"
                  title={t("groupBasic")}
                >
                  <Settings size={16} />
                </button>
                <Switch checked={platform.enabled} loading={toggling} onChange={handleToggle} />
              </div>
            )}
          </div>

          {/* 详情主体 — 无左右 padding，max-w-2xl 居中 */}
          <div className="w-full max-w-2xl mx-auto pt-4 lg:pt-0 pb-10">
            {detailLoading ? (
              <SurfaceSkeleton variant="form" />
            ) : isNew ? (
              <>
                <h1 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 mb-5">
                  {t("createPlatform")}
                </h1>
                {configForm}
              </>
            ) : platform ? (
              <div className="flex flex-col gap-6">
                {/* 熔断恢复提示条 — 平台处于 down 状态时显示 */}
                {platform.status === "down" && (
                  <div className="flex items-center justify-between px-4 py-3 rounded-xl bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-800/40">
                    <div className="flex items-center gap-2 text-sm text-red-700 dark:text-red-400">
                      <Zap size={16} className="shrink-0" />
                      <span>{t("platformDownTip")}</span>
                    </div>
                    <button
                      type="button"
                      onClick={handleUnban}
                      disabled={unbanning}
                      className="shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-600 hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-500 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {unbanning ? (
                        <RefreshCw size={12} className="animate-spin" />
                      ) : (
                        <Zap size={12} />
                      )}
                      {unbanning ? t("common:loading") : t("platformUnban")}
                    </button>
                  </div>
                )}
                {/* 配置表单（上） */}
                {configForm}

                {/* 模型列表（下） */}
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
                  onTestModel={handleTestModel}
                  testLoading={testLoading}
                  testResults={testResults}
                />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}