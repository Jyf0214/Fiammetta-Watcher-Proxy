"use client";

import { useState, useMemo } from "react";
import { Input, Popconfirm } from "antd";
import { Button } from "@/components/ui/Button";
import Switch from "@/components/ui/Switch";
import { RefreshCw, Trash2, Plus, Search, Cpu } from "lucide-react";
import { MODEL_TYPE_CONFIG, getModelBrand, type ModelItem } from "@/lib/platform";

/**
 * 模型管理面板 — 搜索/类型过滤/添加/启停/删除（内嵌于平台详情页）
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

  const typeTabs = [
    { key: "all", label: "全部" },
    { key: "chat", label: "文字" },
    { key: "embedding", label: "向量" },
    { key: "image", label: "图片" },
    { key: "audio", label: "音频" },
  ].filter((tab) => tab.key === "all" || (typeCounts[tab.key] && typeCounts[tab.key] > 0));

  return (
    <div>
      {/* 操作行：全部启用/禁用 + 刷新 */}
      <div className="flex items-center gap-2 mb-3">
        <Button
          variant="default"
          size="sm"
          onClick={() => {
            const allEnabled = models.length > 0 && models.every((m) => m.enabled);
            onToggleAll(!allEnabled);
          }}
          disabled={loading || models.length === 0}
          loading={togglingAll}
        >
          {models.length > 0 && models.every((m) => m.enabled) ? "全部禁用" : "全部启用"}
        </Button>
        <Button variant="default" size="sm" icon={<RefreshCw size={13} />} onClick={onRefreshModels} loading={refreshing}>
          刷新
        </Button>
      </div>

      {/* 搜索 */}
      <div className="flex gap-2 mb-3">
        <Input
          prefix={<Search size={14} className="text-zinc-400" />}
          placeholder="搜索模型…"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          allowClear
          className="flex-1"
          size="small"
        />
      </div>

      {/* 添加 */}
      <div className="flex gap-2 mb-4">
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
      <div className="flex gap-1 mb-4 p-1 bg-zinc-100 dark:bg-zinc-800 rounded-lg">
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
        <div className="space-y-1">
          {filteredModels.map((model) => {
            const typeCfg = MODEL_TYPE_CONFIG[model.type] || MODEL_TYPE_CONFIG.chat;
            const TypeIcon = typeCfg.icon;
            const brand = getModelBrand(model.modelId);

            return (
              <div
                key={model.id}
                className="group flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors"
              >
                <div className={`shrink-0 w-8 h-8 rounded-lg ${typeCfg.bg} flex items-center justify-center`}>
                  <span className={`text-[10px] font-bold ${typeCfg.color}`}>{brand}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate leading-tight">
                    {model.modelId}
                  </p>
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
                <div className="shrink-0">
                  <Switch
                    checked={model.enabled}
                    loading={togglingModelId === model.modelId}
                    onChange={(checked) => onToggleModel(model.modelId, checked)}
                  />
                </div>
                <Popconfirm title="确认删除此模型？" onConfirm={() => onDeleteModel(model.modelId)} okText="确认" cancelText="取消">
                  <button className="shrink-0 p-1.5 rounded-md text-zinc-300 opacity-0 group-hover:opacity-100 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all">
                    <Trash2 size={14} />
                  </button>
                </Popconfirm>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
