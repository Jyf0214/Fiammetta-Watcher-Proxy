"use client";

import { useState, useMemo } from "react";
import { Input, Popconfirm, message, Modal, Select, Alert } from "antd";
import { Button } from "@/components/ui/Button";
import Switch from "@/components/ui/Switch";
import {
  RefreshCw,
  Trash2,
  Plus,
  Search,
  Cpu,
  Grid3x3,
  MessageSquare,
  Image as ImageIcon,
  Layers,
  Mic,
  Video,
  ToggleLeft,
  Zap,
  CheckCircle,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/ui";
import { MODEL_TYPE_CONFIG, type ModelItem } from "@/lib/platform";
import { ModelIcon } from "@/components/platform/ModelIcon";

export interface TestResult {
  name: string;
  keyMasked: string;
  status: "ok" | "error";
  httpStatus: number;
  latencyMs: number;
  error?: string;
}

/**
 * 模型管理面板 — 标题工具条 + 带图标类型 Tabs + 已启用/已禁用分组
 */
export function ModelsPanel({
  models,
  loading,
  refreshing,
  newModelId,
  onNewModelIdChange,
  onAddModel,
  onRefreshModels,
  onDeleteModel,
  onToggleModel,
  onToggleAll,
  togglingAll,
  togglingModelId,
  onTestModel,
  testLoading,
  testResults,
}: {
  models: ModelItem[];
  loading: boolean;
  refreshing: boolean;
  newModelId: string;
  onNewModelIdChange: (v: string) => void;
  onAddModel: () => void;
  onRefreshModels: () => void;
  onDeleteModel: (modelId: string) => void;
  onToggleModel: (modelId: string, enabled: boolean) => void;
  onToggleAll: (enabled: boolean) => void;
  togglingAll: boolean;
  togglingModelId: string | null;
  onTestModel: (modelId: string) => void;
  testLoading: boolean;
  testResults: TestResult[] | null;
}) {
  const { t } = useTranslation("platform");
  const [typeFilter, setTypeFilter] = useState("all");
  const [searchText, setSearchText] = useState("");
  const [testModalOpen, setTestModalOpen] = useState(false);
  const [testModelId, setTestModelId] = useState<string | undefined>(undefined);

  const chatModels = useMemo(() => models.filter((m) => m.type === "chat"), [models]);

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = { all: models.length };
    models.forEach((m) => { counts[m.type] = (counts[m.type] || 0) + 1; });
    return counts;
  }, [models]);

  const filteredModels = useMemo(() => {
    return models.filter((m) => {
      if (typeFilter !== "all" && m.type !== typeFilter) return false;
      if (searchText && !m.modelId.toLowerCase().includes(searchText.toLowerCase())) return false;
      return true;
    });
  }, [models, typeFilter, searchText]);

  // 已启用 / 已禁用分组（对照 EnabledModelList / DisabledModels 两组）
  const { enabledModels, disabledModels } = useMemo(() => {
    const enabled: ModelItem[] = [];
    const disabled: ModelItem[] = [];
    filteredModels.forEach((m) => (m.enabled ? enabled.push(m) : disabled.push(m)));
    return { enabledModels: enabled, disabledModels: disabled };
  }, [filteredModels]);

  // 类型 Tabs：带图标 + 计数，仅显示有模型的数量（除 all 外）
  const typeTabs = [
    { key: "all", label: t("groupAll"), icon: Grid3x3 },
    { key: "chat", label: t(MODEL_TYPE_CONFIG.chat.labelKey), icon: MessageSquare },
    { key: "image", label: t(MODEL_TYPE_CONFIG.image.labelKey), icon: ImageIcon },
    { key: "embedding", label: t(MODEL_TYPE_CONFIG.embedding.labelKey), icon: Layers },
    { key: "audio", label: t(MODEL_TYPE_CONFIG.audio.labelKey), icon: Mic },
    { key: "video", label: t(MODEL_TYPE_CONFIG.video.labelKey), icon: Video },
  ].filter((tab) => tab.key === "all" || (typeCounts[tab.key] && typeCounts[tab.key] > 0));

  const copyModelId = (modelId: string) => {
    navigator.clipboard
      .writeText(modelId)
      .then(() => message.success(t("modelIdCopied")))
      .catch(() => message.error(t("common:copyFailed")));
  };

  /** 单个模型行 — 品牌色图标 + 名称（点击复制）+ hover 编辑/删除 + 类型标签 + 启停开关（对照 ModelItem） */
  const renderModelRow = (model: ModelItem) => {
    const typeCfg = MODEL_TYPE_CONFIG[model.type] || MODEL_TYPE_CONFIG.chat;
    const TypeIcon = typeCfg.icon;

    return (
      <div
        key={model.id}
        className="group flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors"
      >
        <ModelIcon modelId={model.modelId} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => copyModelId(model.modelId)}
              title={t("copyModelIdTip")}
              className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
            >
              {model.modelId}
            </button>
            {/* hover 操作内联在名称后（对照 ModelItem Actions）；触屏无 hover，移动端常显；
                桌面隐藏时同时禁用指针，避免透明按钮仍可点击误删 */}
            <div className="flex items-center gap-0.5 opacity-100 lg:opacity-0 lg:group-hover:opacity-100 lg:pointer-events-none lg:group-hover:pointer-events-auto transition-opacity">
              <Popconfirm
                title={t("deleteModelConfirm")}
                onConfirm={() => onDeleteModel(model.modelId)}
                okText={t("common:confirm")}
                cancelText={t("common:cancel")}
              >
                <button
                  type="button"
                  className="p-1 rounded-md text-zinc-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                >
                  <Trash2 size={13} />
                </button>
              </Popconfirm>
            </div>
          </div>
          <div className="flex items-center gap-1.5 mt-1 text-[11px] text-zinc-400">
            <span>{model.source === "manual" ? t("manual") : t("auto")}</span>
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-md",
              typeCfg.bg,
              typeCfg.color
            )}
          >
            <TypeIcon size={10} />
            {t(typeCfg.labelKey)}
          </span>
          <Switch
            checked={model.enabled}
            loading={togglingModelId === model.modelId}
            onChange={(checked) => onToggleModel(model.modelId, checked)}
          />
        </div>
      </div>
    );
  };

  /** 分组标题 — 12px 次要文字 + 右侧图标操作（对照 EnabledModelList / DisabledModels 分组标题） */
  const renderGroupHeader = (
    label: string,
    count: number,
    action?: { title: string; onClick: () => void; loading: boolean }
  ) => (
    <div className="flex items-center justify-between mt-6 mb-1.5 first:mt-2">
      <span className="text-xs text-zinc-500 dark:text-zinc-400">
        {label}
        <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400">
          {count}
        </span>
      </span>
      {action && count > 0 && (
        <button
          type="button"
          title={action.title}
          onClick={action.onClick}
          disabled={action.loading}
          className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-700 dark:hover:text-zinc-300 disabled:opacity-50 transition-colors"
        >
          {action.loading ? (
            <RefreshCw size={15} className="animate-spin" />
          ) : (
            <ToggleLeft size={15} />
          )}
        </button>
      )}
    </div>
  );

  return (
    <div>
      {/* 标题区：模型列表 + 搜索/刷新（对照 ModelTitle） */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-100">
          {t("models")}
        </h3>
        <div className="flex items-center gap-2">
          <Input
            prefix={<Search size={14} className="text-zinc-400" />}
            placeholder={t("searchPlaceholder")}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            allowClear
            className="w-40"
            size="small"
          />
          <Button
            variant="default"
            size="sm"
            icon={<RefreshCw size={13} />}
            onClick={onRefreshModels}
            loading={refreshing}
          >
            {t("refreshModels")}
          </Button>
          <Button
            variant="default"
            size="sm"
            icon={<Zap size={13} />}
            onClick={() => {
              setTestModelId(chatModels[0]?.modelId);
              setTestModalOpen(true);
            }}
            disabled={chatModels.length === 0}
          >
            {t("testModel")}
          </Button>
        </div>
      </div>

      {/* 添加模型 */}
      <div className="flex gap-2 mb-3">
        <Input
          placeholder={t("modelPlaceholder")}
          value={newModelId}
          onChange={(e) => onNewModelIdChange(e.target.value)}
          onPressEnter={onAddModel}
          className="flex-1"
          size="small"
        />
        <Button
          variant="primary"
          size="sm"
          onClick={onAddModel}
          disabled={!newModelId.trim()}
          icon={<Plus size={13} />}
        >
          {t("addModel")}
        </Button>
      </div>

      {/* 类型 Tab 过滤（带图标，对照参考 Tabs square 变体） */}
      <div className="flex gap-1 p-1 bg-zinc-100 dark:bg-zinc-800 rounded-xl">
        {typeTabs.map((tab) => {
          const Icon = tab.icon;
          const active = typeFilter === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setTypeFilter(tab.key)}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg transition-all duration-200",
                active
                  ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              )}
            >
              <Icon size={13} />
              <span className="hidden sm:inline">{tab.label}</span>
              <span className="text-[10px] tabular-nums text-zinc-400">
                {loading ? "…" : (typeCounts[tab.key] || 0)}
              </span>
            </button>
          );
        })}
      </div>

      {/* 模型列表 */}
      {loading ? (
        <div className="flex items-center justify-center py-12 text-zinc-400">
          <RefreshCw size={20} className="animate-spin mr-2" />{t("common:loading")}…
        </div>
      ) : filteredModels.length === 0 ? (
        <div className="text-center py-12 text-zinc-400">
          <Cpu size={40} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">{searchText ? t("searchNoResult") : t("noModels")}</p>
        </div>
      ) : (
        <>
          {/* 已启用分组 */}
          {renderGroupHeader(t("groupEnabled"), enabledModels.length, {
            title: t("disableAll"),
            onClick: () => onToggleAll(false),
            loading: togglingAll,
          })}
          {enabledModels.length === 0 ? (
            <p className="text-center py-6 text-xs text-zinc-400">{t("noEnabledModels")}</p>
          ) : (
            <div className="space-y-0.5">
              {enabledModels.map(renderModelRow)}
            </div>
          )}

          {/* 已禁用分组 */}
          {renderGroupHeader(t("groupDisabled"), disabledModels.length, {
            title: t("enableAll"),
            onClick: () => onToggleAll(true),
            loading: togglingAll,
          })}
          {disabledModels.length === 0 ? (
            <p className="text-center py-6 text-xs text-zinc-400">{t("noDisabledModels")}</p>
          ) : (
            <div className="space-y-0.5">
              {disabledModels.map(renderModelRow)}
            </div>
          )}
        </>
      )}

      {/* 模型可用性测试 Modal */}
      <Modal
        title={t("testModelTitle")}
        open={testModalOpen}
        onCancel={() => setTestModalOpen(false)}
        footer={null}
        width={520}
        destroyOnClose
      >
        {chatModels.length === 0 ? (
          <p className="text-center py-6 text-sm text-zinc-400">{t("testModelNoChatModels")}</p>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Select
                value={testModelId}
                onChange={setTestModelId}
                className="flex-1"
                placeholder={t("testModelSelectModel")}
                options={chatModels.map((m) => ({ label: m.modelId, value: m.modelId }))}
              />
              <Button
                variant="primary"
                size="sm"
                loading={testLoading}
                disabled={!testModelId}
                onClick={() => testModelId && onTestModel(testModelId)}
                icon={<Zap size={13} />}
              >
                {t("testModelStart")}
              </Button>
            </div>

            {testResults && testResults.length === 0 && !testLoading && (
              <p className="text-center py-4 text-sm text-zinc-400">{t("testModelNoKeys")}</p>
            )}

            {testResults && testResults.length > 0 && (
              <div className="space-y-2">
                {testResults.map((r, idx) => (
                  <div
                    key={idx}
                    className="flex items-start gap-3 p-3 rounded-xl border border-zinc-200 dark:border-zinc-700"
                  >
                    <div className="flex-shrink-0 mt-0.5">
                      {r.status === "ok" ? (
                        <CheckCircle size={16} className="text-emerald-500" />
                      ) : (
                        <XCircle size={16} className="text-red-500" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                          {r.name}
                        </span>
                        <span className="text-xs text-zinc-400 tabular-nums">
                          {r.latencyMs}ms
                        </span>
                      </div>
                      <div className="text-xs text-zinc-400 mt-0.5">
                        {r.keyMasked}
                        {r.httpStatus > 0 && (
                          <span className="ml-2">HTTP {r.httpStatus}</span>
                        )}
                      </div>
                      {r.error && (
                        <div className="mt-2">
                          <Alert
                            type="error"
                            showIcon
                            message={
                              <pre className="text-xs whitespace-pre-wrap break-all m-0">
                                {r.error}
                              </pre>
                            }
                          />
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}