import { useState, useEffect, useMemo, useRef, useCallback, memo } from "react";
import { Input, message } from "antd";
import { Button } from "@/components/ui/Button";
import Switch from "@/components/ui/Switch";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import { AsyncBoundary } from "@/components/ui/AsyncBoundary";
import {
  Zap,
  Copy,
  Check,
  RefreshCw,
  Database,
  Search,
  Router,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { formatDateTime } from "@/lib/timezone";
import { copyToClipboard } from "@/lib/ui";
import useSWR from "swr";
import { useApi, apiFetcher, UNAUTHORIZED_MESSAGE } from "@/hooks/use-api";
import { type Platform } from "@/components/platform/PlatformList";
import AdminLayout from "@/components/AdminLayout";

interface PlatformModel {
  id: string;
  modelId: string;
  ownedBy: string | null;
  source: string;
  /** 秒级 Unix 时间戳（platform_models.fetched_at 为 Int 列） */
  fetchedAt: number;
  platform: { name: string };
}

/** 单个模型行 — memo 化：搜索/开关更新只重渲染受影响的行
 *  （多平台聚合可达数千行，行内联渲染时每次击键全列表重渲染导致卡顿） */
const AutoModelRow = memo(function AutoModelRow({
  model,
  platforms,
  enabled,
  saving,
  onToggle,
}: {
  model: PlatformModel;
  /** 该模型出现的平台列表（引用由页面 useMemo 保持稳定） */
  platforms: { name: string }[];
  enabled: boolean;
  /** 保存请求进行中（开关 loading 态） */
  saving: boolean;
  onToggle: (modelId: string, checked: boolean) => void;
}) {
  const { t } = useTranslation("system");
  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition-all duration-150 ${
        enabled
          ? "bg-zinc-50 dark:bg-zinc-800/50 border-zinc-300 dark:border-zinc-700"
          : "bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700"
      }`}
    >
      {/* 开关 */}
      <Switch
        checked={enabled}
        onChange={(checked) => onToggle(model.modelId, checked)}
        loading={saving}
        className="shrink-0"
      />

      {/* 平台信息 */}
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <Database size={14} className="text-zinc-400 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
              {model.modelId}
            </span>
            <span
              className={`shrink-0 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                model.source === "manual"
                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                  : "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
              }`}
            >
              {model.source === "manual" ? t("platform:manual") : t("platform:auto")}
            </span>
          </div>
          {platforms.length > 0 && (
            <div className="flex items-center gap-1 mt-0.5 text-xs text-zinc-400 dark:text-zinc-500">
              <Router size={10} />
              {platforms.map((p) => p.name).join(" · ")}
            </div>
          )}
        </div>
      </div>

      {/* 更新时间 */}
      <span className="shrink-0 text-xs text-zinc-400 dark:text-zinc-500 hidden sm:block">
        {formatDateTime(model.fetchedAt)}
      </span>
    </div>
  );
});

export default function AutoModelPage() {
  const { t } = useTranslation("system");

  // 自动模型 ID 状态
  const [autoModelLoading, setAutoModelLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  // 已启用的 modelId 集合（唯一键，同一 modelId 多平台行联动）
  const [enabledModelIds, setEnabledModelIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  // 防抖：快速多次切换时合并保存
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 最新启用集合镜像：防抖回调读取 ref 而非过期闭包，避免最后一次切换丢失
  const enabledModelIdsRef = useRef<Set<string>>(new Set());
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ===== 数据层（SWR）：config 与 platforms 并行拉取，平台模型并行批量请求 =====

  const { data: config, mutate: mutateConfig } = useApi<Record<string, string>>("/api/admin/config");
  const autoModelId = config?.["system:auto_model_id"] ?? null;
  // 三态解析（与 worker router.ts 的 autoModelSelected 解析口径一致）：
  // - 键缺失/非法 JSON → null（未配置 = 全部模型参与分流）
  // - 显式空数组 → []（全部关闭）
  // - 数组元素全非法（如 [1,2]）→ 过滤后为空且原始非空 → null（降级为全部参与）
  const savedModelIds = useMemo(() => {
    const saved = config?.["system:auto_model_selected"];
    if (saved === undefined || saved === null || saved === "") return null;
    try {
      const parsed = JSON.parse(saved);
      if (!Array.isArray(parsed)) return null;
      const filtered = parsed.filter((m): m is string => typeof m === "string");
      if (filtered.length > 0 || parsed.length === 0) return filtered;
      return null;
    } catch {
      return null;
    }
  }, [config]);

  const { data: platforms, error: platformsError } = useApi<Platform[]>("/api/admin/platforms");
  useEffect(() => {
    if (platformsError && platformsError.message !== UNAUTHORIZED_MESSAGE) {
      message.error(t("common:error"));
    }
  }, [platformsError, t]);

  const modelsKey =
    platforms && platforms.length > 0
      ? JSON.stringify(platforms.map((p) => `/api/admin/platforms/${p.id}/models`))
      : null;
  const { data: models, isLoading: modelsLoading } = useSWR<PlatformModel[]>(
    modelsKey,
    async (key: string) => {
      const urls: string[] = JSON.parse(key);
      const groups = await Promise.all(
        urls.map(async (url) => {
          try {
            const list = (await apiFetcher<PlatformModel[]>(url)) ?? [];
            const platformId = url.split("/")[4];
            const name = platforms?.find((p) => p.id === platformId)?.name ?? platformId;
            return list.map((m) => ({ ...m, platform: { name } }));
          } catch {
            return [];
          }
        })
      );
      return groups.flat();
    }
  );

  // 初始化：config 与 models 加载完成（空数组也算完成）后将已保存的选择填入
  // enabledModelIds——此前要求 models 非空，平台存在但模型列表为空时已保存的
  // 启用集合永不载入，UI 显示与持久化状态不符。
  // 未配置（savedModelIds === null）时 UI 表达"全部参与"：所有模型开关置开，
  // 与运行期 null=全部参与 的口径一致（此前显示全部关闭，与真实行为相反）
  const initializedRef = useRef(false);
  useEffect(() => {
    if (!initializedRef.current && config !== undefined && models !== undefined) {
      initializedRef.current = true;
      const next =
        savedModelIds === null
          ? new Set((models ?? []).map((m) => m.modelId))
          : new Set(savedModelIds);
      enabledModelIdsRef.current = next;
      setEnabledModelIds(next);
    }
  }, [config, models, savedModelIds]);

  /** 重新生成自动模型 ID */
  const regenerateAutoModelId = async () => {
    setAutoModelLoading(true);
    try {
      const hex = Array.from({ length: 16 }, () =>
        Math.floor(Math.random() * 16).toString(16)
      ).join("");
      const newId = `fwp-auto-model-${hex}`;

      const res = await fetch("/api/admin/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "system:auto_model_id", value: newId }),
      });
      const data: Record<string, any> = await res.json();
      if (data.success) {
        mutateConfig();
        message.success(t("autoModelRegenerated"));
      } else {
        message.error(typeof data.error === "string" ? data.error : t("common:error"));
      }
    } catch {
      message.error(t("common:error"));
    } finally {
      setAutoModelLoading(false);
    }
  };

  // 统一走共享剪贴板工具：HTTP 部署下 navigator.clipboard 为 undefined，直调同步抛错且 .then 接不住
  const copyAutoModelId = async () => {
    if (!autoModelId) return;
    if (await copyToClipboard(autoModelId)) {
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => {
        copiedTimerRef.current = null;
        setCopied(false);
      }, 2000);
    } else {
      message.error(t("common:copyFailed"));
    }
  };

  /** 保存当前启用集合到 config（函数声明：卸载 effect 在渲染期之后执行，
   *  需提升声明消除 no-use-before-define，闭包捕获与 const 版一致） */
  async function persistEnabledModels(ids: Set<string>) {
    setSaving(true);
    try {
      const visibleIds = new Set(
        (models ?? [])
          .filter((m) => ids.has(m.modelId))
          .map((m) => m.modelId)
      );
      const modelIds = Array.from(
        new Set([
          ...(savedModelIds ?? []).filter((id) => !(models ?? []).some((m) => m.modelId === id)),
          ...visibleIds,
        ])
      );
      const res = await fetch("/api/admin/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "system:auto_model_selected",
          value: JSON.stringify(modelIds),
        }),
      });
      const data: Record<string, any> = await res.json();
      if (data.success) {
        mutateConfig();
      } else {
        message.error(typeof data.error === "string" ? data.error : t("common:error"));
        // 失败回滚：UI 恢复为服务器已保存状态（未配置=全部参与），开关不得停留在未保存状态
        const rollback =
          savedModelIds === null
            ? new Set((models ?? []).map((m) => m.modelId))
            : new Set(savedModelIds);
        enabledModelIdsRef.current = rollback;
        setEnabledModelIds(rollback);
      }
    } catch {
      message.error(t("common:error"));
      const rollback =
        savedModelIds === null
          ? new Set((models ?? []).map((m) => m.modelId))
          : new Set(savedModelIds);
      enabledModelIdsRef.current = rollback;
      setEnabledModelIds(rollback);
    } finally {
      setSaving(false);
    }
  };

  // 卸载 flush 引用最新 persistEnabledModels：ref 承载最新闭包，
  // 供卸载 effect 与 useCallback 化的 toggleModel 稳定调用（声明置于函数声明之后，
  // 消除 use-before-declare；函数声明提升保证 useRef 初始值合法）
  const persistEnabledModelsRef = useRef(persistEnabledModels);
  useEffect(() => {
    persistEnabledModelsRef.current = persistEnabledModels;
  });
  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      // 卸载时若 500ms 防抖窗口内还有未落盘的切换，立即 flush 保存，
      // 避免「切换后立刻离开页面」丢失最后一次修改
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        void persistEnabledModelsRef.current(enabledModelIdsRef.current);
      }
    };
  }, []);

  /** 切换模型启用状态（带防抖，避免频繁保存）；
   *  经 persistEnabledModelsRef 取最新闭包，回调引用稳定供 memo 行使用 */
  const toggleModel = useCallback((modelId: string, checked: boolean) => {
    setEnabledModelIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(modelId);
      else next.delete(modelId);
      enabledModelIdsRef.current = next;
      return next;
    });
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void persistEnabledModelsRef.current(enabledModelIdsRef.current);
    }, 500);
  }, []);

  // 搜索过滤
  const [modelSearch, setModelSearch] = useState("");
  const filteredModels = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    if (!q) return models ?? [];
    return (models ?? []).filter(
      (m) =>
        m.modelId.toLowerCase().includes(q) ||
        m.platform.name.toLowerCase().includes(q)
    );
  }, [models, modelSearch]);

  // 去重后的唯一模型列表（保留第一个平台行，避免重复渲染同一模型）
  const uniqueModels = useMemo(() => {
    const seen = new Set<string>();
    return filteredModels.filter((m) => {
      if (seen.has(m.modelId)) return false;
      seen.add(m.modelId);
      return true;
    });
  }, [filteredModels]);

  // 统计每个唯一 modelId 出现在哪些平台
  const modelPlatforms = useMemo(() => {
    const map = new Map<string, { name: string }[]>();
    for (const m of filteredModels) {
      const arr = map.get(m.modelId) ?? [];
      arr.push(m.platform);
      map.set(m.modelId, arr);
    }
    return map;
  }, [filteredModels]);

  return (
    <AdminLayout>
      <PageContainer>
        <PageHeader
          icon={<Zap size={20} className="text-zinc-500 dark:text-zinc-400" />}
          title={t("admin:autoModel")}
          description={t("admin:autoModelDesc")}
        />

        {/* 自动模型 ID 配置 */}
        <ProCard
          title={
            <span className="flex items-center gap-2">
              <Zap size={16} />
              {t("autoModelTitle")}
            </span>
          }
          className="mb-4"
        >
          <p className="text-zinc-500 dark:text-zinc-400 text-sm mb-4">
            {t("autoModelDesc")}
          </p>
          {autoModelId ? (
            <div className="flex items-center gap-3">
              <code className="flex-1 bg-zinc-100 dark:bg-zinc-800 px-3 py-2 rounded-lg text-sm font-mono break-all">
                {autoModelId}
              </code>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={copied ? <Check size={14} /> : <Copy size={14} />}
                onClick={copyAutoModelId}
                title={copied ? t("common:copied") : t("common:copy")}
              />
              <Button
                variant="default"
                size="sm"
                icon={<RefreshCw size={14} />}
                onClick={regenerateAutoModelId}
                loading={autoModelLoading}
              >
                {t("autoModelRegenerate")}
              </Button>
            </div>
          ) : (
            <Button
              variant="primary"
              size="sm"
              onClick={regenerateAutoModelId}
              loading={autoModelLoading}
            >
              {t("autoModelEnable")}
            </Button>
          )}
        </ProCard>

        {/* 已发现的模型 — 开关式选择参与自动分流的模型 */}
        <ProCard
          title={
            <span className="flex items-center gap-2">
              <Database size={16} />
              {t("admin:autoModelDiscovered")}
              <span className="text-xs font-normal text-zinc-400 dark:text-zinc-500 ml-1">
                {enabledModelIds.size > 0 && `· ${enabledModelIds.size} ${t("autoModelCountEnabled")}`}
              </span>
            </span>
          }
        >
          {savedModelIds === null && (
            <div className="mb-4 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
              {t("autoModelAllEnabled")}
            </div>
          )}
          <div className="mb-4">
            <Input
              prefix={<Search size={14} className="text-zinc-400" />}
              placeholder={t("autoModelSearchPlaceholder")}
              value={modelSearch}
              onChange={(e) => setModelSearch(e.target.value)}
              allowClear
              size="small"
              className="max-w-sm"
            />
          </div>

          {modelsLoading ? (
            <AsyncBoundary isLoading error={null}>
              <></>
            </AsyncBoundary>
          ) : uniqueModels.length === 0 ? (
            <AsyncBoundary
              isLoading={false}
              error={null}
              isEmpty
              emptyIcon={<Database className="w-10 h-10" />}
              emptyTitle={t("autoModelNoModels")}
            >
              <></>
            </AsyncBoundary>
          ) : (
            <div className="space-y-2">
              {uniqueModels.map((m) => (
                <AutoModelRow
                  key={m.modelId}
                  model={m}
                  platforms={modelPlatforms.get(m.modelId) ?? []}
                  enabled={enabledModelIds.has(m.modelId)}
                  saving={saving}
                  onToggle={toggleModel}
                />
              ))}
            </div>
          )}
        </ProCard>
      </PageContainer>
    </AdminLayout>
  );
}
