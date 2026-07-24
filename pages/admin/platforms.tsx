import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Popconfirm,
  Tag,
  Form,
  Input,
  InputNumber,
  Select,
  Drawer,
  message,
  type TableColumnsType,
} from "antd";
import { Button } from "@/components/ui/Button";
import Switch from "@/components/ui/Switch";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import { Plus, Pencil, Trash2, Database, RefreshCw, Cloud, Copy, Cpu, MessageSquare, Image, Mic, Box, Layers, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import GlobalLoading from "@/components/Loading";
import AdminLayout from "@/components/AdminLayout";

interface Platform {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  apiKeys: string;
  type: string;
  enabled: boolean;
  priority: number;
  weight: number;
  rpmLimit: number | null;
  tpmLimit: number | null;
  forwardHeaders: string;
  status: string;
}

interface NamedApiKey {
  name: string;
  key: string;
}

/** 移动端平台卡片 */
function PlatformCard({
  platform,
  togglingId,
  onToggle,
  onEdit,
  onDelete,
  onModels,
}: {
  platform: Platform;
  togglingId: string | null;
  onToggle: (p: Platform) => void;
  onEdit: (p: Platform) => void;
  onDelete: (id: string) => void;
  onModels: (p: Platform) => void;
}) {
  const { t } = useTranslation();
  const statusColor = platform.status === "healthy" ? "green" : platform.status === "degraded" ? "orange" : "red";

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">{platform.name}</h3>
          <Tag color={statusColor} className="!text-[10px] !px-1.5 !py-0 !m-0 shrink-0">{platform.status}</Tag>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-zinc-400">{platform.enabled ? t("common.enable") : t("common.disable")}</span>
          <Switch checked={platform.enabled} loading={togglingId === platform.id} onChange={() => onToggle(platform)} />
        </div>
      </div>
      <div className="px-4 pb-2 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-zinc-400 w-12 shrink-0">类型</span>
          <Tag className="!text-[10px] !px-1.5 !py-0 !m-0">{platform.type}</Tag>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-zinc-400 w-12 shrink-0">地址</span>
          <span className="text-[11px] text-zinc-600 dark:text-zinc-300 truncate font-mono">{platform.baseUrl}</span>
        </div>
        {(platform.priority !== 0 || platform.weight !== 1) && (
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-zinc-400 w-12 shrink-0">权重</span>
            <span className="text-[11px] text-zinc-600 dark:text-zinc-300">优先级 {platform.priority} · 权重 {platform.weight}</span>
          </div>
        )}
      </div>
      <div className="flex border-t border-zinc-100 dark:border-zinc-800">
        <button onClick={() => onModels(platform)} className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs text-zinc-500 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors">
          <Database size={13} /> 模型
        </button>
        <div className="w-px bg-zinc-100 dark:bg-zinc-800" />
        <button onClick={() => onEdit(platform)} className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs text-zinc-500 hover:text-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors">
          <Pencil size={13} /> 编辑
        </button>
        <div className="w-px bg-zinc-100 dark:bg-zinc-800" />
        <Popconfirm title={t("common.confirm_delete")} onConfirm={() => onDelete(platform.id)} okText={t("common.confirm")} cancelText={t("common.cancel")}>
          <button className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs text-zinc-500 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
            <Trash2 size={13} /> 删除
          </button>
        </Popconfirm>
      </div>
    </div>
  );
}

/** 模型类型图标映射 */
const MODEL_TYPE_CONFIG: Record<string, { icon: typeof Cpu; label: string; color: string; bg: string }> = {
  chat:       { icon: MessageSquare, label: "文字", color: "text-blue-500",   bg: "bg-blue-50 dark:bg-blue-900/30" },
  embedding:  { icon: Layers,       label: "向量", color: "text-cyan-500",   bg: "bg-cyan-50 dark:bg-cyan-900/30" },
  image:      { icon: Image,        label: "图片", color: "text-purple-500", bg: "bg-purple-50 dark:bg-purple-900/30" },
  audio:      { icon: Mic,          label: "音频", color: "text-orange-500", bg: "bg-orange-50 dark:bg-orange-900/30" },
  video:      { icon: Box,          label: "视频", color: "text-pink-500",   bg: "bg-pink-50 dark:bg-pink-900/30" },
  moderation: { icon: Cpu,          label: "审核", color: "text-red-500",    bg: "bg-red-50 dark:bg-red-900/30" },
};

/** 根据模型 ID 猜测品牌首字母 */
function getModelBrand(modelId: string): string {
  const parts = modelId.split("/");
  const brand = parts.length > 1 ? parts[0] : modelId.split("-")[0];
  return brand.slice(0, 2).toUpperCase();
}

interface ModelItem {
  id: string;
  modelId: string;
  ownedBy: string | null;
  source: string;
  type: string;
  enabled: boolean;
  fetchedAt: string;
}

/** 模型管理抽屉 — LobeChat 风格列表 */
function ModelDrawer({
  open, onClose, platform, models, loading, refreshing,
  newModelId, onNewModelIdChange, onAddModel, onRefreshModels, onDeleteModel, onToggleModel, onToggleAll, togglingAll,
}: {
  open: boolean;
  onClose: () => void;
  platform: Platform | null;
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
}) {
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [searchText, setSearchText] = useState("");

  // 关闭时重置筛选（通过 onClose 回调触发）
  const handleClose = () => {
    setTypeFilter("all");
    setSearchText("");
    onClose();
  };

  // 类型统计
  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = { all: models.length };
    models.forEach((m) => { counts[m.type] = (counts[m.type] || 0) + 1; });
    return counts;
  }, [models]);

  // 筛选后的模型列表
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
    <Drawer
      open={open}
      onClose={handleClose}
      width={480}
      title={
        <div className="flex flex-col">
          <span className="flex items-center gap-2 text-base font-semibold">
            <Database size={16} />{platform?.name}
          </span>
          <span className="text-xs text-zinc-400 font-normal mt-0.5">
            {loading ? "加载中…" : `共 ${models.length} 个可用模型`}
          </span>
        </div>
      }
      extra={
        <div className="flex items-center gap-2">
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
      }
    >
      {/* 搜索 + 添加 */}
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
      <div className="flex gap-2 mb-4">
        <Input
          placeholder="输入模型 ID 添加"
          value={newModelId}
          onChange={(e) => onNewModelIdChange(e.target.value)}
          onPressEnter={onAddModel}
          className="flex-1"
          size="small"
        />
        <Button variant="primary" size="sm" onClick={onAddModel} disabled={!newModelId.trim()}>添加</Button>
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
                {/* 品牌图标 */}
                <div className={`shrink-0 w-8 h-8 rounded-lg ${typeCfg.bg} flex items-center justify-center`}>
                  <span className={`text-[10px] font-bold ${typeCfg.color}`}>{brand}</span>
                </div>

                {/* 模型信息 */}
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

                {/* 启禁用 */}
                <div className="shrink-0">
                  <Switch
                    checked={model.enabled}
                    onChange={(checked) => onToggleModel(model.modelId, checked)}
                  />
                </div>

                {/* 删除 */}
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
    </Drawer>
  );
}

/** 平台表单（Drawer 内使用） */
function PlatformForm({
  form,
  editing,
  namedKeys,
  onAddKey,
  onRemoveKey,
  onUpdateKeyName,
  onUpdateKeyValue,
  onCopyKey,
  onSubmit,
  submitting,
  onClose,
}: {
  form: ReturnType<typeof Form.useForm>[0];
  editing: Platform | null;
  namedKeys: NamedApiKey[];
  onAddKey: () => void;
  onRemoveKey: (i: number) => void;
  onUpdateKeyName: (i: number, v: string) => void;
  onUpdateKeyValue: (i: number, v: string) => void;
  onCopyKey: (k: string) => void;
  onSubmit: () => void;
  submitting: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  return (
    <Form form={form} layout="vertical" onFinish={onSubmit} className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto px-1 space-y-1">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0">
          <Form.Item name="name" label={t("platform.name")} rules={[{ required: true }]} className="!mb-3">
            <Input />
          </Form.Item>
          <Form.Item name="baseUrl" label={t("platform.base_url")} rules={[{ required: true }]} className="!mb-3">
            <Input placeholder="https://api.openai.com/v1" />
          </Form.Item>
        </div>

        {/* API 密钥区域 */}
        <Form.Item
          label={t("platform.api_key") || "API 密钥"}
          tooltip={t("platform.additional_keys_tip") || "支持多个密钥，自动轮询分摊调用量"}
          rules={editing ? [] : [{ required: true }]}
          className="!mb-3"
        >
          <div className="space-y-2">
            {namedKeys.map((namedKey, index) => (
              <div key={index} className="flex items-center gap-1.5 p-2 bg-zinc-50 dark:bg-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-700">
                <Input
                  value={namedKey.name}
                  onChange={(e) => onUpdateKeyName(index, e.target.value)}
                  placeholder="名称"
                  className="!w-16 !min-w-0 shrink-0"
                  size="small"
                />
                <Input.Password
                  value={namedKey.key}
                  onChange={(e) => onUpdateKeyValue(index, e.target.value)}
                  placeholder={editing ? "留空保持原密钥" : "输入 API 密钥"}
                  className="!flex-1 !min-w-0 font-mono text-xs"
                  size="small"
                />
                <button
                  type="button"
                  onClick={() => onCopyKey(namedKey.key)}
                  disabled={!namedKey.key}
                  className="shrink-0 p-1.5 rounded text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title="复制"
                >
                  <Copy size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => onRemoveKey(index)}
                  disabled={namedKeys.length <= 1}
                  className="shrink-0 p-1.5 rounded text-zinc-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title="删除"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            <Button variant="default" onClick={onAddKey} icon={<Plus size={14} />} block size="sm">添加密钥</Button>
          </div>
        </Form.Item>

        <div className="grid grid-cols-2 gap-x-4 gap-y-0">
          <Form.Item name="type" label={t("platform.type")} initialValue="openai" className="!mb-3">
            <Select options={[{ value: "openai", label: "OpenAI" }, { value: "azure", label: "Azure" }, { value: "custom", label: "Custom" }]} />
          </Form.Item>
          <div /> {/* 占位 */}
          <Form.Item name="priority" label={t("platform.priority")} initialValue={0} className="!mb-3">
            <InputNumber min={0} className="!w-full" />
          </Form.Item>
          <Form.Item name="weight" label={t("platform.weight")} initialValue={1} className="!mb-3">
            <InputNumber min={1} className="!w-full" />
          </Form.Item>
          <Form.Item name="rpmLimit" label={t("platform.rpm_limit")} className="!mb-3">
            <InputNumber min={0} placeholder={t("common.unlimited")} className="!w-full" />
          </Form.Item>
          <Form.Item name="tpmLimit" label={t("platform.tpm_limit")} className="!mb-3">
            <InputNumber min={0} placeholder={t("common.unlimited")} className="!w-full" />
          </Form.Item>
        </div>

        <Form.Item name="forwardHeaders" label={t("platform.forward_headers")} className="!mb-3">
          <Input.TextArea rows={2} placeholder={"每行一个 Header 名称\nX-Thinking-Mode\nX-Reasoning-Effort"} />
        </Form.Item>
      </div>

      {/* 底部固定按钮 */}
      <div className="shrink-0 flex gap-3 pt-3 mt-2 border-t border-zinc-100 dark:border-zinc-800">
        <Button variant="default" onClick={onClose} className="flex-1 sm:flex-none">{t("common.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={submitting} autoLoading={false} className="flex-1 sm:flex-none">
          {submitting ? t("common.loading") : editing ? t("common.save") : t("common.create")}
        </Button>
      </div>
    </Form>
  );
}

export default function PlatformsPage() {
  const { t } = useTranslation();
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [formVisible, setFormVisible] = useState(false);
  const [editing, setEditing] = useState<Platform | null>(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [namedKeys, setNamedKeys] = useState<NamedApiKey[]>([{ name: "密钥1", key: "" }]);
  const [modelDrawerOpen, setModelDrawerOpen] = useState(false);
  const [modelPlatform, setModelPlatform] = useState<Platform | null>(null);
  const [models, setModels] = useState<Array<{ id: string; modelId: string; ownedBy: string | null; source: string; type: string; enabled: boolean; fetchedAt: string }>>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [newModelId, setNewModelId] = useState("");
  const [togglingAll, setTogglingAll] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const fetchPlatforms = async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/admin/platforms", { signal: controller.signal });
        const data = await res.json() as Record<string, any>;
        if (data.success && Array.isArray(data.data)) setPlatforms(data.data);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        message.error(t("common.error"));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    fetchPlatforms();
    return () => controller.abort();
  }, [t, refreshKey]);

  const handleRefresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const openCreateForm = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ type: "openai", priority: 0, weight: 1 });
    setNamedKeys([{ name: "密钥1", key: "" }]);
    setFormVisible(true);
  };

  const openEditForm = (platform: Platform) => {
    setEditing(platform);
    const parsed: NamedApiKey[] = [];
    if (platform.apiKey && platform.apiKey.trim()) parsed.push({ name: "主密钥", key: platform.apiKey });
    if (platform.apiKeys) {
      try {
        const arr = JSON.parse(platform.apiKeys);
        if (Array.isArray(arr)) {
          if (arr.length > 0 && typeof arr[0] === "object" && arr[0] !== null && "key" in arr[0]) {
            arr.forEach((item: NamedApiKey) => {
              if (item && typeof item.key === "string" && item.key.trim()) parsed.push({ name: item.name || `密钥${parsed.length + 1}`, key: item.key });
            });
          } else {
            arr.forEach((key: string, idx: number) => {
              if (typeof key === "string" && key.trim()) parsed.push({ name: `密钥${idx + 1}`, key });
            });
          }
        }
      } catch { /* ignore */ }
    }
    if (parsed.length === 0) parsed.push({ name: "密钥1", key: "" });
    setNamedKeys(parsed);
    form.setFieldsValue(platform);
    setFormVisible(true);
  };

  const closeForm = () => { setFormVisible(false); setEditing(null); form.resetFields(); };

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
    navigator.clipboard.writeText(key);
    message.success("已复制到剪贴板");
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const validKeys = namedKeys.filter((k) => k.key && k.key.trim());
      if (validKeys.length > 0) {
        values.apiKey = validKeys[0].key;
        values.apiKeys = validKeys.length > 1 ? JSON.stringify(validKeys.slice(1)) : "[]";
      }
      // forwardHeaders: 按行分割为数组
      if (typeof values.forwardHeaders === "string") {
        const lines = values.forwardHeaders.split("\n").map((l: string) => l.trim()).filter(Boolean);
        values.forwardHeaders = lines.length > 0 ? JSON.stringify(lines) : "";
      }
      const url = editing ? `/api/admin/platforms/${editing.id}` : "/api/admin/platforms";
      const method = editing ? "PUT" : "POST";
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
      const data = await res.json() as Record<string, any>;
      if (data.success) { message.success(data.message); closeForm(); handleRefresh(); }
      else message.error(data.error || t("common.error"));
    } catch (err) {
      if (err && typeof err === "object" && "errorFields" in err) return;
      message.error(t("common.error"));
    } finally { setSubmitting(false); }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/platforms/${id}`, { method: "DELETE" });
      const data = await res.json() as Record<string, any>;
      if (data.success) { message.success(t("platform.delete_success") || "删除成功"); handleRefresh(); }
      else message.error(data.error || t("common.error"));
    } catch { message.error(t("common.error")); }
  };

  const handleToggle = async (platform: Platform) => {
    try {
      setTogglingId(platform.id);
      const res = await fetch(`/api/admin/platforms/${platform.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !platform.enabled }),
      });
      const data = await res.json() as Record<string, any>;
      if (data.success) handleRefresh();
      else message.error(data.error || t("common.error"));
    } catch { message.error(t("common.error")); }
    finally { setTogglingId(null); }
  };

  const openModelDrawer = (platform: Platform) => {
    setModelPlatform(platform); setModelDrawerOpen(true); fetchModels(platform.id);
  };

  const fetchModels = async (platformId: string) => {
    setModelsLoading(true);
    try {
      const res = await fetch(`/api/admin/platforms/${platformId}/models`);
      const data = await res.json() as Record<string, any>;
      if (data.success) setModels(data.data || []);
    } catch { message.error(t("common.error")); }
    finally { setModelsLoading(false); }
  };

  const handleRefreshModels = async () => {
    if (!modelPlatform) return;
    setRefreshing(true);
    try {
      const res = await fetch(`/api/admin/platforms/${modelPlatform.id}/models`, { method: "PUT" });
      const data = await res.json() as Record<string, any>;
      if (data.success) { message.success(data.message); fetchModels(modelPlatform.id); }
      else message.error(data.error || t("common.error"));
    } catch { message.error(t("common.error")); }
    finally { setRefreshing(false); }
  };

  const handleAddModel = async () => {
    if (!modelPlatform || !newModelId.trim()) return;
    try {
      const res = await fetch(`/api/admin/platforms/${modelPlatform.id}/models`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId: newModelId.trim() }),
      });
      const data = await res.json() as Record<string, any>;
      if (data.success) { message.success(data.message); setNewModelId(""); fetchModels(modelPlatform.id); }
      else message.error(data.error || t("common.error"));
    } catch { message.error(t("common.error")); }
  };

  const handleDeleteModel = async (modelId: string) => {
    if (!modelPlatform) return;
    try {
      const res = await fetch(`/api/admin/platforms/${modelPlatform.id}/models?modelId=${encodeURIComponent(modelId)}`, { method: "DELETE" });
      const data = await res.json() as Record<string, any>;
      if (data.success) fetchModels(modelPlatform.id);
      else message.error(data.error || t("common.error"));
    } catch { message.error(t("common.error")); }
  };

  const handleToggleModel = async (modelId: string, enabled: boolean) => {
    if (!modelPlatform) return;
    try {
      const res = await fetch(`/api/admin/platforms/${modelPlatform.id}/models`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId, enabled }),
      });
      const data = await res.json() as Record<string, any>;
      if (data.success) fetchModels(modelPlatform.id);
      else message.error(data.error || t("common.error"));
    } catch { message.error(t("common.error")); }
  };

  const handleToggleAll = async (enabled: boolean) => {
    if (!modelPlatform) return;
    setTogglingAll(true);
    try {
      const res = await fetch(`/api/admin/platforms/${modelPlatform.id}/models`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json() as Record<string, any>;
      if (data.success) fetchModels(modelPlatform.id);
      else message.error(data.error || t("common.error"));
    } catch { message.error(t("common.error")); }
    finally { setTogglingAll(false); }
  };

  const columns: TableColumnsType<Platform> = [
    { title: t("platform.name"), dataIndex: "name", key: "name", width: 140, ellipsis: true },
    { title: t("platform.base_url"), dataIndex: "baseUrl", key: "baseUrl", ellipsis: true, responsive: ["md"] },
    { title: t("platform.type"), dataIndex: "type", key: "type", width: 100, render: (v: string) => <Tag>{v}</Tag>, responsive: ["sm"] },
    { title: t("platform.priority"), dataIndex: "priority", key: "priority", width: 80, align: "center", responsive: ["lg"] },
    { title: t("platform.weight"), dataIndex: "weight", key: "weight", width: 80, align: "center", responsive: ["lg"] },
    { title: t("platform.rpm_limit"), dataIndex: "rpmLimit", key: "rpmLimit", width: 100, align: "center", render: (v: number | null) => v ?? "-", responsive: ["xl"] },
    { title: t("platform.tpm_limit"), dataIndex: "tpmLimit", key: "tpmLimit", width: 100, align: "center", render: (v: number | null) => v ?? "-", responsive: ["xl"] },
    {
      title: t("common.status"), key: "enabled", width: 120, align: "center",
      render: (_: unknown, record: Platform) => (
        <div className="flex items-center justify-center gap-2">
          <span className="text-xs text-zinc-500">{record.enabled ? t("common.enable") : t("common.disable")}</span>
          <Switch checked={record.enabled} loading={togglingId === record.id} onChange={() => handleToggle(record)} />
        </div>
      ),
    },
    {
      title: t("common.actions"), key: "actions", fixed: "right", width: 150, align: "center",
      render: (_: unknown, record: Platform) => (
        <div className="flex items-center justify-center gap-1">
          <Button variant="ghost" size="sm" iconOnly icon={<Database size={14} />} onClick={() => openModelDrawer(record)} />
          <Button variant="ghost" size="sm" iconOnly icon={<Pencil size={14} />} onClick={() => openEditForm(record)} />
          <Popconfirm title={t("common.confirm_delete")} onConfirm={() => handleDelete(record.id)}>
            <Button variant="dangerGhost" size="sm" iconOnly icon={<Trash2 size={14} />} />
          </Popconfirm>
        </div>
      ),
    },
  ];

  if (loading && platforms.length === 0) {
    return <AdminLayout><GlobalLoading size="large" /></AdminLayout>;
  }

  return (
    <AdminLayout>
      <PageContainer>
        <PageHeader
          icon={<Cloud size={20} className="text-zinc-500 dark:text-zinc-400" />}
          title={t("admin.platforms")}
          description={t("admin.platforms_desc")}
          extra={<Button variant="primary" icon={<Plus size={14} />} onClick={openCreateForm}>{t("platform.create_platform")}</Button>}
        />

        {/* 移动端卡片 */}
        <div className="block lg:hidden space-y-3">
          {platforms.map((p) => (
            <PlatformCard key={p.id} platform={p} togglingId={togglingId} onToggle={handleToggle} onEdit={openEditForm} onDelete={handleDelete} onModels={openModelDrawer} />
          ))}
          {platforms.length === 0 && !loading && (
            <div className="text-center py-12 text-zinc-400">
              <Cloud size={48} className="mx-auto mb-4 opacity-30" />
              <p className="text-sm">{t("platform.no_platforms") || "暂无平台"}</p>
              <Button variant="primary" size="sm" className="mt-4" onClick={openCreateForm} icon={<Plus size={14} />}>{t("platform.create_platform")}</Button>
            </div>
          )}
        </div>

        {/* 桌面端表格 */}
        <div className="hidden lg:block">
          <ProCard>
            <ResponsiveTable columns={columns} dataSource={platforms} rowKey="id" loading={loading}
              pagination={{ pageSize: 20, showTotal: (total) => t("common.pagination_total", { count: total }) }}
              scroll={{ x: 900 }}
            />
          </ProCard>
        </div>

        {/* 编辑/新增抽屉 */}
        <Drawer
          title={editing ? t("platform.edit_platform") : t("platform.create_platform")}
          open={formVisible}
          onClose={closeForm}
          width={520}
          destroyOnClose
          styles={{ body: { padding: "16px", display: "flex", flexDirection: "column", height: "calc(100vh - 56px)" } }}
        >
          <PlatformForm
            form={form}
            editing={editing}
            namedKeys={namedKeys}
            onAddKey={addNamedKey}
            onRemoveKey={removeNamedKey}
            onUpdateKeyName={updateKeyName}
            onUpdateKeyValue={updateKeyValue}
            onCopyKey={copyKeyValue}
            onSubmit={handleSubmit}
            submitting={submitting}
            onClose={closeForm}
          />
        </Drawer>

        {/* 模型管理抽屉 */}
        <ModelDrawer
          open={modelDrawerOpen}
          onClose={() => setModelDrawerOpen(false)}
          platform={modelPlatform}
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
        />
      </PageContainer>
    </AdminLayout>
  );
}
