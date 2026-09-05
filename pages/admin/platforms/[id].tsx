import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from "react";
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
import { ArrowLeft, RefreshCw, Zap, Settings, ShieldOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { useApi, UNAUTHORIZED_MESSAGE } from "@/hooks/use-api";
import AdminLayout from "@/components/AdminLayout";
import { SurfaceSkeleton } from "@/components/ui/SurfaceSkeleton";
import {
  parseNamedKeys,
  parseForwardHeaders,
  parseExtraHeadersText,
  serializeExtraHeaders,
  type ModelItem,
  type NamedApiKey,
} from "@/lib/platform";
import { copyToClipboard } from "@/lib/ui";

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
  const [togglingAll, setTogglingAll] = useState(false);
  const [togglingModelId, setTogglingModelId] = useState<string | null>(null);

  // 模型测试状态
  const [testLoading, setTestLoading] = useState(false);
  const [testResults, setTestResults] = useState<TestResult[] | null>(null);

  // ===== 数据层（SWR）：列表 / 详情 / 模型三路并行，key 含 id 变化时自动重新请求 =====
  // 列表 key 与平台列表页（/admin/platforms）共享同一缓存：详情页左侧栏与列表页数据自动一致
  // refreshInterval 30s：密钥 429 封禁/降级状态与平台熔断状态轮询刷新（#12）
  const listKey = "/api/admin/platforms";
  // 详情与模型仅在非新建模式下请求（key 为 null 时不发请求）
  const detailKey = !id || isNew ? null : `/api/admin/platforms/${id}`;
  const modelsKey = !id || isNew ? null : `/api/admin/platforms/${id}/models`;

  const {
    data: platforms,
    error: listError,
    isValidating: listLoading,
    mutate: mutateList,
  } = useApi<Platform[]>(listKey, { refreshInterval: 30_000 });

  const {
    data: platform,
    error: detailError,
    isLoading: detailLoading,
    mutate: mutateDetail,
  } = useApi<Platform | null>(detailKey, { refreshInterval: 30_000 });

  const {
    data: models,
    error: modelsError,
    isValidating: modelsLoading,
    mutate: mutateModels,
  } = useApi<ModelItem[]>(modelsKey);

  // 密钥实时状态汇总（keyStatuses 键为密钥指纹；429 封禁/白名单降级）
  const keyStatusSummary = useMemo(() => {
    const statuses = platform?.keyStatuses ?? {};
    let banned = 0;
    let deprioritized = 0;
    for (const value of Object.values(statuses)) {
      if (value?.status === "banned") banned++;
      else if (value?.status === "deprioritized") deprioritized++;
    }
    return { banned, deprioritized, total: banned + deprioritized };
  }, [platform]);

  // 可用代理 URL 列表（供密钥级代理绑定选择器）
  const [availableProxyUrls, setAvailableProxyUrls] = useState<Array<{ url: string; group: string; enabled: boolean }>>([]);
  useEffect(() => {
    fetch("/api/admin/upstream-proxy/urls")
      .then((r) => r.json())
      .then((d: unknown) => { const r = d as { success: boolean; data?: Array<{ url: string; group: string; enabled: boolean }> }; if (r.success && Array.isArray(r.data)) setAvailableProxyUrls(r.data); })
      .catch(() => {});
  }, []);

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
    // 平台切换后清空上一平台的模型测试状态，避免残留结果串显
    setTestResults(null);
    setTestLoading(false);
  }

  // 新增模式：进入时初始化默认表单值（仅一次，重复渲染不覆盖）
  useLayoutEffect(() => {
    if (!isNew || syncedForNew) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSyncedForNew(true);
    form.resetFields();
    // injectStreamOptions 必须显式初始化为 true（与后端 POST 缺省一致）：
    // 留空时开关渲染为关、落库却是开，表单展示与实际生效值相反
    form.setFieldsValue({ type: "openai", additionalTypes: [], priority: 0, weight: 1, injectStreamOptions: true });
    setNamedKeys([{ name: defaultKeyName(1), key: "" }]);
  }, [isNew, syncedForNew, form, defaultKeyName]);

  // 详情加载完成：将平台配置同步进表单（同一 id 只同步一次，之后的重新验证不覆盖用户编辑）
  useLayoutEffect(() => {
    if (isNew || !platform || !id) return;
    if (syncedForId === id) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSyncedForId(id);
    // 单平台多协议：编辑模式把 types 拆成 type（首选）+ additionalTypes（附加）。
    // types 缺失/解析失败时回退 [type]（与 lib/types.ts resolvePlatformProtocols 对齐）。
    // types 在 API 层已被解析为 string[] 形态（前端 Platform 类型），但保守起见仍
    // 兼容 JSON 字符串形态（旧客户端或第三方 API 直接返回字符串的场景）。
    let primaryType: string = platform.type;
    let additionalTypes: string[] = [];
    if (Array.isArray(platform.types)) {
      if (platform.types.length > 0) {
        primaryType = platform.types[0];
        additionalTypes = platform.types.slice(1);
      }
    } else if (typeof platform.types === "string") {
      try {
        const parsed = JSON.parse(platform.types) as string[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          primaryType = parsed[0];
          additionalTypes = parsed.slice(1);
        }
      } catch {
        // 非法 JSON → 沿用默认（仅 type）
      }
    }
    form.setFieldsValue({
      ...platform,
      type: primaryType,
      additionalTypes,
      forwardHeaders: parseForwardHeaders(platform.forwardHeaders),
      extraHeaders: parseExtraHeadersText(platform.extraHeaders),
    });
    const parsed = parseNamedKeys(platform, t("keyNamePrefix"));
    setNamedKeys(parsed.length > 0 ? parsed : [{ name: defaultKeyName(1), key: "" }]);
  }, [platform, id, isNew, syncedForId, form, t, defaultKeyName]);

  // ---------- 密钥编辑 ----------
  // namedKeysRef 承载最新列表：下方回调全部 useCallback 稳定引用，供
  // PlatformConfigForm 的 memo 密钥行做 props 浅比较——否则每次击键都会
  // 因回调换引用导致全部行重渲染（大密钥量下输入极端卡顿）
  const namedKeysRef = useRef(namedKeys);
  useEffect(() => {
    namedKeysRef.current = namedKeys;
  });

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

  const removeNamedKey = useCallback((index: number) => {
    if (namedKeysRef.current.length <= 1) {
      message.warning(t("atLeastOneKey"));
      return;
    }
    setNamedKeys(namedKeysRef.current.filter((_, i) => i !== index));
  }, [t]);

  const updateKeyName = useCallback((index: number, name: string) => {
    const keys = [...namedKeysRef.current];
    keys[index] = { ...keys[index], name };
    setNamedKeys(keys);
  }, []);

  const updateKeyValue = useCallback((index: number, key: string) => {
    const keys = [...namedKeysRef.current];
    keys[index] = { ...keys[index], key };
    setNamedKeys(keys);
  }, []);

  // 统一走共享剪贴板工具：HTTP（非 localhost）部署下 navigator.clipboard 不存在，
  // 直调会同步抛 TypeError 且 .catch 接不住，按钮表现为"点了没反应"
  const copyKeyValue = useCallback(async (key: string) => {
    const ok = await copyToClipboard(key);
    if (ok) message.success(t("common:copied"));
    else message.error(t("common:copyFailed"));
  }, [t]);

  const handleToggleWhitelist = useCallback((index: number) => {
    const next = [...namedKeysRef.current];
    const newState = !next[index].whitelisted;
    next[index] = { ...next[index], whitelisted: newState };
    setNamedKeys(next);
    message.info(newState ? t("whitelistAdded") : t("whitelistRemoved"));
  }, [t]);

  const handleUpdateKeyProxyUrls = useCallback((index: number, urls: string[]) => {
    const next = [...namedKeysRef.current];
    next[index] = { ...next[index], proxyUrls: urls.length > 0 ? urls : undefined };
    setNamedKeys(next);
  }, []);

  const handleUpdateKeyProxyStrict = useCallback((index: number, strict: boolean) => {
    const next = [...namedKeysRef.current];
    next[index] = { ...next[index], proxyStrict: strict ? undefined : false };
    setNamedKeys(next);
  }, []);

  const handleToggleKey = useCallback(async (index: number, enabled: boolean) => {
    if (!id || isNew) return;
    const targetKey = namedKeysRef.current[index]?.key;
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
        const next = [...namedKeysRef.current];
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
  }, [id, isNew, t, mutateDetail, mutateList]);

  // ---------- 保存 / 删除 / 启停 ----------
  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      const validKeys = namedKeys.filter((k) => k.key && k.key.trim());
      if (validKeys.length === 0) {
        // 编辑模式同样拦截：PUT 不传 apiKeys 会静默保留旧密钥，
        // 清空输入框后保存只会让旧密钥"复活"且无提示
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
            if (k.proxyUrls && k.proxyUrls.length > 0) obj.proxyUrls = k.proxyUrls;
            if (k.proxyStrict === false) obj.proxyStrict = false;
            return obj;
          })
        );
      }
      if (typeof values.forwardHeaders === "string") {
        const lines = values.forwardHeaders.split("\n").map((l: string) => l.trim()).filter(Boolean);
        values.forwardHeaders = lines.length > 0 ? JSON.stringify(lines) : "";
      }
      if (typeof values.extraHeaders === "string") {
        values.extraHeaders = serializeExtraHeaders(values.extraHeaders);
      }
      // 单平台多协议：把 type + additionalTypes 合并为 types[] 提交给 API。
      // 服务端会做首项对齐校验（types[0] === type），这里只负责形态组装。
      if (values.type !== undefined) {
        const primary = String(values.type);
        const extras = Array.isArray(values.additionalTypes)
          ? (values.additionalTypes as unknown[]).filter(
              (p): p is string => typeof p === "string" && p !== primary
            )
          : [];
        const seen = new Set<string>();
        const types: string[] = [];
        for (const p of [primary, ...extras]) {
          if (!seen.has(p)) {
            seen.add(p);
            types.push(p);
          }
        }
        values.types = types;
        // additionalTypes 不应被序列化到后端（后端 schema 未定义、API 校验未识别）
        delete values.additionalTypes;
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
  // 全部 useCallback 稳定引用：ModelsPanel 为 memo 组件且内部持有搜索/新增输入框，
  // 回调换引用会让输入每次击键都全量重渲染所有模型行
  const handleTestModel = useCallback(async (modelId: string) => {
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
  }, [id, isNew, t]);

  const handleRefreshModels = useCallback(async () => {
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
  }, [id, isNew, t, mutateModels]);

  // 输入值由 ModelsPanel 内部持有：成功返回 true，面板据此清空输入框
  const handleAddModel = useCallback(async (modelId: string): Promise<boolean> => {
    if (!id || isNew || !modelId.trim()) return false;
    try {
      const res = await fetch(`/api/admin/platforms/${id}/models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId: modelId.trim() }),
      });
      const data = (await res.json()) as Record<string, any>;
      if (data.success) {
        message.success(data.message);
        mutateModels();
        return true;
      } else {
        message.error(data.error || t("common:error"));
        return false;
      }
    } catch {
      message.error(t("common:error"));
      return false;
    }
  }, [id, isNew, t, mutateModels]);

  const handleDeleteModel = useCallback(async (modelId: string) => {
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
  }, [id, isNew, t, mutateModels]);

  const handleToggleModel = useCallback(async (modelId: string, enabled: boolean) => {
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
  }, [id, isNew, t, mutateModels]);

  const handleToggleAll = useCallback(async (enabled: boolean) => {
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
  }, [id, isNew, t, mutateModels]);

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
      onUpdateKeyProxyUrls={handleUpdateKeyProxyUrls}
      onUpdateKeyProxyStrict={handleUpdateKeyProxyStrict}
      availableProxyUrls={availableProxyUrls}
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
            className="h-[calc(100vh-6rem)] overflow-y-auto"
          />
        </div>

        {/* 右侧：详情主体 */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* 移动端返回条（sticky 吸顶 — 移出 overflow 容器使其相对 body 滚动生效；top-16 对齐 64px 顶栏下缘、z-30 低于面包屑；-mx-4 -mt-4 抵消 AdminLayout p-4 实现左右撑满+顶部贴齐；h-[52px] 固定高度供 ModelsPanel 吸顶偏移引用） */}
          <div className="lg:hidden sticky top-16 z-30 bg-white/95 dark:bg-zinc-900/95 backdrop-blur -mx-4 -mt-4 px-4 py-2.5 h-[52px] flex items-center justify-between border-b border-zinc-200/80 dark:border-zinc-800">
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
                  <BrandAvatar name={platform.name} type={platform.type} presetId={platform.presetId} size="sm" />
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

          {/* 详情主体 — 无左右 padding，max-w-2xl 居中；不含 overflow 容器，ModelsPanel sticky 相对 body 生效 */}
          <div className="flex-1 min-w-0 w-full max-w-2xl mx-auto pt-4 lg:pt-0 pb-10">
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
                {/* 密钥 429 封禁/降级提示条 — 任一 Key 处于临时封禁/降级时显示 */}
                {keyStatusSummary.total > 0 && (
                  <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-orange-50 dark:bg-orange-900/10 border border-orange-200 dark:border-orange-800/40 text-sm text-orange-700 dark:text-orange-400">
                    <ShieldOff size={16} className="shrink-0" />
                    <span>
                      {t("keyStatusSummary", {
                        count: keyStatusSummary.total,
                        banned: keyStatusSummary.banned,
                        deprioritized: keyStatusSummary.deprioritized,
                      })}
                    </span>
                  </div>
                )}
                {/* 配置表单（上） */}
                {configForm}

                {/* 模型列表（下） */}
                <ModelsPanel
                  models={models ?? []}
                  loading={modelsLoading}
                  refreshing={refreshing}
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
            ) : detailError ? (
              <div className="flex flex-col items-center justify-center gap-3 py-24 text-sm text-zinc-500 dark:text-zinc-400">
                <span>{t("common:error")}</span>
                <button
                  type="button"
                  onClick={() => mutateDetail()}
                  className="px-4 py-1.5 rounded-lg border border-zinc-300 dark:border-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                >
                  {t("common:retry")}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}