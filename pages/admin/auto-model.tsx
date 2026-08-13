import { useState, useEffect, useMemo, useRef } from "react";
import { Input, Checkbox, message, type TableColumnsType } from "antd";
import { Button } from "@/components/ui/Button";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import { Zap, Copy, Check, RefreshCw, Database, Search } from "lucide-react";
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

  // 模型选择状态：行 id 为唯一勾选来源（同一 modelId 可存在于多个平台行），保存时派生 modelId 集合
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [selectedModelsLoading, setSelectedModelsLoading] = useState(false);
  const [modelSearch, setModelSearch] = useState("");

  // ===== 数据层（SWR）：config 与 platforms 并行拉取，平台模型并行批量请求 =====

  // config：自动模型 ID 与已保存的选择（原串行链第一步）
  const { data: config, mutate: mutateConfig } = useApi<Record<string, string>>("/api/admin/config");
  const autoModelId = config?.["system:auto_model_id"] ?? null;
  // config 中已保存的选择（部分平台加载失败时用于兜底保留，避免保存静默丢配置）
  const savedModelIds = useMemo(() => {
    const saved = config?.["system:auto_model_selected"];
    if (!saved) return [] as string[];
    try {
      return JSON.parse(saved) as string[];
    } catch {
      return [] as string[];
    }
  }, [config]);

  // 平台列表（原串行链第二步）
  const { data: platforms, error: platformsError } = useApi<Platform[]>("/api/admin/platforms");
  useEffect(() => {
    if (platformsError && platformsError.message !== UNAUTHORIZED_MESSAGE) {
      message.error(t("common:error"));
    }
  }, [platformsError, t]);

  // 各平台模型（原串行 N+1 第三步 → 并行）：platforms 就绪后一次性并行请求所有平台的模型，
  // 单个平台失败不影响其他平台（与原行为一致）。key 为 URL 列表的 JSON 序列化，
  // platforms 变化（增删平台）时自动重新请求。
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
            // 从 URL 提取平台 id 并合并平台名（原 for 循环内 push 时附加）
            const platformId = url.split("/")[4];
            const name = platforms?.find((p) => p.id === platformId)?.name ?? platformId;
            return list.map((m) => ({ ...m, platform: { name } }));
          } catch {
            return []; // 单个平台失败不影响其他
          }
        })
      );
      return groups.flat();
    }
  );

  // 已保存的模型选择扩散为对应行勾选（同一模型在多平台的全部行，代表该模型在路由池）。
  // 仅在 config 与 models 首次就绪时执行一次，之后不覆盖用户手动勾选。
  const initializedRef = useRef(false);
  useEffect(() => {
    if (!initializedRef.current && config !== undefined && (models ?? []).length > 0) {
      initializedRef.current = true;
      setSelectedKeys(
        (models ?? [])
          .filter((m) => savedModelIds.includes(m.modelId))
          .map((m) => m.id)
      );
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
        mutateConfig(); // 重新拉取 config，autoModelId 由 SWR 数据驱动更新
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

  /** 复制自动模型 ID */
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

  /** 保存模型选择（行勾选 → 唯一 modelId 集合；并集保留已保存但当前不可见的选择，避免平台加载失败时静默丢配置） */
  const saveSelectedModels = async () => {
    setSelectedModelsLoading(true);
    try {
      const visibleIds = new Set(
        (models ?? [])
          .filter((m) => selectedKeys.includes(m.id))
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
        mutateConfig(); // 重新拉取 config，更新 savedModelIds 兜底值
        message.success(t("autoModelSelectedSaved"));
      } else {
        message.error(data.error || t("common:error"));
      }
    } catch {
      message.error(t("common:error"));
    } finally {
      setSelectedModelsLoading(false);
    }
  };

  /** 勾选切换：行 id 为勾选来源（同 modelId 多平台行独立勾选，保存时去重）；桌面表格与移动端卡片共用此列 */
  const toggleSelect = (id: string, checked: boolean) => {
    setSelectedKeys((prev) =>
      checked
        ? prev.includes(id)
          ? prev
          : [...prev, id]
        : prev.filter((k) => k !== id)
    );
  };

  /** 表格内搜索：按模型 ID / 平台名过滤 */
  const filteredModels = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    if (!q) return models ?? [];
    return (models ?? []).filter(
      (m) =>
        m.modelId.toLowerCase().includes(q) ||
        m.platform.name.toLowerCase().includes(q)
    );
  }, [models, modelSearch]);

  const columns: TableColumnsType<PlatformModel> = [
    {
      title: "",
      key: "select",
      width: 44,
      render: (_: unknown, record: PlatformModel) => (
        <Checkbox
          checked={selectedKeys.includes(record.id)}
          onChange={(e) => toggleSelect(record.id, e.target.checked)}
          aria-label={record.modelId}
        />
      ),
    },
    {
      title: t("admin:platforms"),
      key: "platform",
      width: 120,
      render: (_: unknown, record: PlatformModel) => (
        <span className="flex items-center gap-1.5">
          <Database size={14} className="text-zinc-400" />
          {record.platform.name}
        </span>
      ),
    },
    {
      title: t("platform:modelId"),
      dataIndex: "modelId",
      key: "modelId",
      ellipsis: true,
    },
    {
      title: t("platform:modelSource"),
      dataIndex: "source",
      key: "source",
      width: 80,
      render: (v: string) => (
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
            v === "manual"
              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
              : "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
          }`}
        >
          {v === "manual" ? t("platform:manual") : t("platform:auto")}
        </span>
      ),
    },
    {
      title: t("common:updatedAt"),
      dataIndex: "fetchedAt",
      key: "fetchedAt",
      width: 180,
      render: (v: string) => formatDateTime(v),
    },
  ];

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

        {/* 已发现的模型列表 — 行勾选即选择参与自动分流的模型（选择器与表格合并，避免双份同源展示） */}
        <ProCard
          title={
            <span className="flex items-center gap-2">
              <Database size={16} />
              {t("admin:autoModelDiscovered")}
            </span>
          }
          extra={
            <Button
              variant="primary"
              size="sm"
              onClick={saveSelectedModels}
              loading={selectedModelsLoading}
              disabled={selectedKeys.length === 0}
            >
              {t("common:save")}
            </Button>
          }
        >
          <div className="mb-3">
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
          <ResponsiveTable
            columns={columns}
            dataSource={filteredModels}
            rowKey="id"
            loading={modelsLoading}
            pagination={{ pageSize: 20, showTotal: (total) => t("common:pagination", { count: total }) }}
            scroll={{ x: 600 }}
          />
        </ProCard>
      </PageContainer>
    </AdminLayout>
  );
}
