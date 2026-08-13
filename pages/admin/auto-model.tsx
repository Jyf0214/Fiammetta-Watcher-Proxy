import { useState, useEffect, useMemo, useRef } from "react";
import { Input, message } from "antd";
import { Button } from "@/components/ui/Button";
import Switch from "@/components/ui/Switch";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
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
import useSWR from "swr";
import { useApi, apiFetcher, UNAUTHORIZED_MESSAGE } from "@/hooks/use-api";
import { type Platform } from "@/components/platform/PlatformList";
import AdminLayout from "@/components/AdminLayout";

interface PlatformModel {
  id: string;
  modelId: string;
  ownedBy: string | null;
  source: string;
  fetchedAt: string;
  platform: { name: string };
}

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

  // ===== 数据层（SWR）：config 与 platforms 并行拉取，平台模型并行批量请求 =====

  const { data: config, mutate: mutateConfig } = useApi<Record<string, string>>("/api/admin/config");
  const autoModelId = config?.["system:auto_model_id"] ?? null;
  const savedModelIds = useMemo(() => {
    const saved = config?.["system:auto_model_selected"];
    if (!saved) return [] as string[];
    try {
      return JSON.parse(saved) as string[];
    } catch {
      return [] as string[];
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

  // 初始化：config 与 models 就绪后将已保存的选择填入 enabledModelIds
  const initializedRef = useRef(false);
  useEffect(() => {
    if (!initializedRef.current && config !== undefined && (models ?? []).length > 0) {
      initializedRef.current = true;
      setEnabledModelIds(new Set(savedModelIds));
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
        message.error(data.error || t("common:error"));
      }
    } catch {
      message.error(t("common:error"));
    } finally {
      setAutoModelLoading(false);
    }
  };

  const copyAutoModelId = () => {
    if (autoModelId) {
      navigator.clipboard.writeText(autoModelId).then(
        () => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        },
        () => message.error(t("common:copyFailed"))
      );
    }
  };

  /** 保存当前启用集合到 config */
  const persistEnabledModels = async (ids: Set<string>) => {
    setSaving(true);
    try {
      const visibleIds = new Set(
        (models ?? [])
          .filter((m) => ids.has(m.modelId))
          .map((m) => m.modelId)
      );
      const modelIds = Array.from(
        new Set([
          ...savedModelIds.filter((id) => !(models ?? []).some((m) => m.modelId === id)),
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
        message.error(data.error || t("common:error"));
      }
    } catch {
      message.error(t("common:error"));
    } finally {
      setSaving(false);
    }
  };

  /** 切换模型启用状态（带防抖，避免频繁保存） */
  const toggleModel = (modelId: string, checked: boolean) => {
    setEnabledModelIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(modelId);
      else next.delete(modelId);
      return next;
    });
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      persistEnabledModels(enabledModelIds);
    }, 500);
  };

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
            <div className="flex items-center justify-center py-16 text-zinc-300 dark:text-zinc-600">
              <RefreshCw size={28} className="animate-spin" />
            </div>
          ) : uniqueModels.length === 0 ? (
            <div className="text-center py-16 text-zinc-400">
              <Database size={40} className="mx-auto mb-3 opacity-30" />
              <p className="text-sm">{t("autoModelNoModels")}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {uniqueModels.map((m) => {
                const isOn = enabledModelIds.has(m.modelId);
                const platforms = modelPlatforms.get(m.modelId) ?? [];
                return (
                  <div
                    key={m.modelId}
                    className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition-all duration-150 ${
                      isOn
                        ? "bg-blue-50/60 dark:bg-blue-900/10 border-blue-200 dark:border-blue-800/40"
                        : "bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700"
                    }`}
                  >
                    {/* 开关 */}
                    <Switch
                      checked={isOn}
                      onChange={(checked) => toggleModel(m.modelId, checked)}
                      loading={saving}
                      className="shrink-0"
                    />

                    {/* 平台信息 */}
                    <div className="flex-1 min-w-0 flex items-center gap-2">
                      <Database size={14} className="text-zinc-400 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                            {m.modelId}
                          </span>
                          <span
                            className={`shrink-0 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                              m.source === "manual"
                                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                                : "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
                            }`}
                          >
                            {m.source === "manual" ? t("platform:manual") : t("platform:auto")}
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
                      {formatDateTime(m.fetchedAt)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </ProCard>
      </PageContainer>
    </AdminLayout>
  );
}
