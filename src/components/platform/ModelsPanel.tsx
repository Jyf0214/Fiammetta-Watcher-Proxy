"use client";

import { useState, useMemo } from "react";
import { Input, Popconfirm, message } from "antd";
import { Button } from "@/components/ui/Button";
import Switch from "@/components/ui/Switch";
import { RefreshCw, Trash2, Plus, Search, Pencil, Cpu } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MODEL_TYPE_CONFIG, getModelBrand, type ModelItem } from "@/lib/platform";

/**
 * 模型管理面板 — 标题工具条 + 类型 Tabs + 已启用/已禁用分组（对照 ProviderDetail 的 ModelList）
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
}) {
  const { t } = useTranslation();
  const [typeFilter, setTypeFilter] = useState("all");
  const [searchText, setSearchText] = useState("");

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

  const { enabledModels, disabledModels } = useMemo(() => {
    const enabled: ModelItem[] = [];
    const disabled: ModelItem[] = [];
    filteredModels.forEach((m) => (m.enabled ? enabled.push(m) : disabled.push(m)));
    return { enabledModels: enabled, disabledModels: disabled };
  }, [filteredModels]);

  const typeTabs = [
    { key: "all", label: t("platform.models") },
    { key: "chat", label: "文字" },
    { key: "embedding", label: "向量" },
    { key: "image", label: "图片" },
    { key: "audio", label: "音频" },
    { key: "video", label: "视频" },
  ].filter((tab) => tab.key === "all" || (typeCounts[tab.key] && typeCounts[tab.key] > 0));

  const copyModelId = (modelId: string) => {
    navigator.clipboard
      .writeText(modelId)
      .then(() => message.success("已复制模型 ID"))
      .catch(() => message.error("复制失败"));
  };

  /** 单个模型行 — 图标 + 名称（点击复制 ID）+ hover 编辑/删除 + 启停开关（对照 ModelItem） */
  const renderModelRow = (model: ModelItem) => {
    const typeCfg = MODEL_TYPE_CONFIG[model.type] || MODEL_TYPE_CONFIG.chat;
    const TypeIcon = typeCfg.icon;
    const brand = getModelBrand(model.modelId);

    return (
      <div
        key={model.id}
        className="group flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors"
      >
        <div className={`shrink-0 w-8 h-8 rounded-lg ${typeCfg.bg} flex items-center justify-center`}>
          <span className={`text-[10px] font-bold ${typeCfg.color}`}>{brand}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => copyModelId(model.modelId)}
              title="点击复制模型 ID"
              className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate hover:text-blue-500 dark:hover:text-blue-400 transition-colors"
            >
              {model.modelId}
            </button>
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className={`inline-flex items-center gap-0.5 text-[10px] ${typeCfg.color}`}>
              <TypeIcon size={10} />
              {typeCfg.label}
            </span>
            <span className="text-[10px] text-zinc-400">
              {model.source === "manual" ? "手动" : "自动"}
            </span>
          </div>
        </div>
        {/* hover 操作（编辑暂未实现，仅对齐交互） */}
        <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            title="模型配置"
            className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
          >
            <Pencil size={14} />
          </button>
          <Popconfirm
            title="确认删除此模型？"
            onConfirm={() => onDeleteModel(model.modelId)}
            okText="确认"
            cancelText="取消"
          >
            <button
              type="button"
              className="p-1.5 rounded-md text-zinc-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
            >
              <Trash2 size={14} />
            </button>
          </Popconfirm>
        </div>
        <div className="shrink-0">
          <Switch
            checked={model.enabled}
            loading={togglingModelId === model.modelId}
            onChange={(checked) => onToggleModel(model.modelId, checked)}
          />
        </div>
      </div>
    );
  };

  /** 分组标题 — 12px 次要文字 + 计数 + 右侧操作（对照 EnabledModelList / DisabledModels 分组标题） */
  const renderGroupHeader = (label: string, count: number, action?: React.ReactNode) => (
    <div className="flex items-center justify-between px-1 mt-6 mb-1 first:mt-2">
      <span className="text-xs text-zinc-500 dark:text-zinc-400 font-medium">
        {label}
        <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400">
          {count}
        </span>
      </span>
      {action}
    </div>
  );

  return (
    <div>
      {/* 标题区：模型列表 + 搜索/刷新/新建（对照 ModelTitle） */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-100">
          {t("platform.models")}
        </h3>
        <div className="flex items-center gap-2">
          <Input
            prefix={<Search size={14} className="text-zinc-400" />}
            placeholder="搜索模型…"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            allowClear
            className="w-40"
            size="small"
          />
          <Button variant="default" size="sm" icon={<RefreshCw size={13} />} onClick={onRefreshModels} loading={refreshing}>
            刷新
          </Button>
        </div>
      </div>

      {/* 添加模型 */}
      <div className="flex gap-2 mb-3">
        <Input
          placeholder="输入模型 ID 添加"
          value={newModelId}
          onChange={(e) => onNewModelIdChange(e.target.value)}
          onPressEnter={onAddModel}
          className="flex-1"
          size="small"
        />
        <Button variant="primary" size="sm" onClick={onAddModel} disabled={!newModelId.trim()} icon={<Plus size={13} />}>
          添加
        </Button>
      </div>

      {/* 类型 Tab 过滤 */}
      <div className="flex gap-1 p-1 bg-zinc-100 dark:bg-zinc-800 rounded-lg">
        {typeTabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setTypeFilter(tab.key)}
            className={`
              flex-1 px-2 py-1.5 text-xs font-medium rounded-md transition-all duration-200
              ${typeFilter === tab.key
                ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 border border-zinc-200 dark:border-zinc-600"
                : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              }
            `}
          >
            {tab.label}
            <span className="ml-1 text-[10px] text-zinc-400">{loading ? "…" : (typeCounts[tab.key] || 0)}</span>
          </button>
        ))}
      </div>

      {/* 模型列表 */}
      {loading ? (
        <div className="flex items-center justify-center py-12 text-zinc-400">
          <RefreshCw size={20} className="animate-spin mr-2" />加载中…
        </div>
      ) : filteredModels.length === 0 ? (
        <div className="text-center py-12 text-zinc-400">
          <Cpu size={40} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">{searchText ? "无匹配模型" : "暂无模型"}</p>
        </div>
      ) : (
        <>
          {renderGroupHeader(
            "已启用",
            enabledModels.length,
            enabledModels.length > 0 ? (
              <Button variant="default" size="sm" onClick={() => onToggleAll(false)} loading={togglingAll} disabled={loading}>
                全部禁用
              </Button>
            ) : undefined
          )}
          {enabledModels.length === 0 ? (
            <p className="text-center py-6 text-xs text-zinc-400">暂无已启用模型</p>
          ) : (
            <div className="space-y-0.5">
              {enabledModels.map(renderModelRow)}
            </div>
          )}

          {renderGroupHeader(
            "已禁用",
            disabledModels.length,
            disabledModels.length > 0 ? (
              <Button variant="default" size="sm" onClick={() => onToggleAll(true)} loading={togglingAll} disabled={loading}>
                全部启用
              </Button>
            ) : undefined
          )}
          {disabledModels.length === 0 ? (
            <p className="text-center py-6 text-xs text-zinc-400">暂无已禁用模型</p>
          ) : (
            <div className="space-y-0.5">
              {disabledModels.map(renderModelRow)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
