import { useState, useEffect } from "react";
import { Select, Empty, message } from "antd";
import { Button } from "@/components/ui/Button";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import { Zap, Copy, Check, RefreshCw, Database, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
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
  const { t } = useTranslation();

  // 自动模型 ID 状态
  const [autoModelId, setAutoModelId] = useState<string | null>(null);
  const [autoModelLoading, setAutoModelLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  // 平台模型发现状态
  const [models, setModels] = useState<PlatformModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);

  // 模型选择状态
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [selectedModelsLoading, setSelectedModelsLoading] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    const fetchAllData = async () => {
      setModelsLoading(true);
      try {
        const res = await fetch("/api/admin/config", { signal: controller.signal });
        const data = await res.json();
        if (data.success && data.data) {
          setAutoModelId(data.data["system:auto_model_id"] || null);
          const savedModels = data.data["system:auto_model_selected"];
          if (savedModels) {
            try {
              setSelectedModels(JSON.parse(savedModels));
            } catch {
              setSelectedModels([]);
            }
          }
        }
      } catch {
        // 静默失败
      }

      try {
        const pRes = await fetch("/api/admin/platforms", { signal: controller.signal });
        const pData = await pRes.json();
        if (pData.success && Array.isArray(pData.data)) {
          const allModels: PlatformModel[] = [];
          for (const platform of pData.data) {
            try {
              const mRes = await fetch(`/api/admin/platforms/${platform.id}/models`, { signal: controller.signal });
              const mData = await mRes.json();
              if (mData.success && Array.isArray(mData.data)) {
                for (const m of mData.data) {
                  allModels.push({ ...m, platform: { name: platform.name } });
                }
              }
            } catch {
              // 单个平台失败不影响其他
            }
          }
          setModels(allModels);
        }
      } catch {
        message.error(t("common.error"));
      } finally {
        setModelsLoading(false);
      }
    };

    fetchAllData();
    return () => controller.abort();
  }, [t]);

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
      const data = await res.json();
      if (data.success) {
        setAutoModelId(newId);
        message.success(t("system.auto_model_regenerated") || "自动模型 ID 已重新生成");
      } else {
        message.error(data.error || t("common.error"));
      }
    } catch {
      message.error(t("common.error"));
    } finally {
      setAutoModelLoading(false);
    }
  };

  /** 复制自动模型 ID */
  const copyAutoModelId = () => {
    if (autoModelId) {
      navigator.clipboard.writeText(autoModelId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  /** 保存模型选择 */
  const saveSelectedModels = async () => {
    setSelectedModelsLoading(true);
    try {
      const res = await fetch("/api/admin/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "system:auto_model_selected",
          value: JSON.stringify(selectedModels),
        }),
      });
      const data = await res.json();
      if (data.success) {
        message.success(t("system.auto_model_selected_saved") || "模型选择已保存");
      } else {
        message.error(data.error || t("common.error"));
      }
    } catch {
      message.error(t("common.error"));
    } finally {
      setSelectedModelsLoading(false);
    }
  };

  const columns = [
    {
      title: t("admin.platforms"),
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
      title: t("platform.model_id"),
      dataIndex: "modelId",
      key: "modelId",
      ellipsis: true,
    },
    {
      title: t("platform.model_source"),
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
          {v === "manual" ? "手动" : "自动"}
        </span>
      ),
    },
    {
      title: t("common.updated_at"),
      dataIndex: "fetchedAt",
      key: "fetchedAt",
      width: 180,
      render: (v: string) => new Date(v).toLocaleString(),
    },
  ];

  return (
    <AdminLayout>
      <PageContainer>
        <PageHeader
          icon={<Zap size={20} className="text-zinc-500 dark:text-zinc-400" />}
          title={t("admin.auto_model")}
          description={t("admin.auto_model_desc")}
        />

        {/* 自动模型 ID 配置 */}
        <ProCard
          title={
            <span className="flex items-center gap-2">
              <Zap size={16} />
              {t("system.auto_model_title") || "自动模型"}
            </span>
          }
          className="mb-4"
        >
          <p className="text-zinc-500 dark:text-zinc-400 text-sm mb-4">
            {t("system.auto_model_desc") || "配置后，请求此模型 ID 时将自动轮询所有可用平台。"}
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
                title={copied ? t("common.copied") : t("common.copy")}
              />
              <Button
                variant="default"
                size="sm"
                icon={<RefreshCw size={14} />}
                onClick={regenerateAutoModelId}
                loading={autoModelLoading}
              >
                {t("system.auto_model_regenerate") || "重新生成"}
              </Button>
            </div>
          ) : (
            <Button
              variant="primary"
              size="sm"
              onClick={regenerateAutoModelId}
              loading={autoModelLoading}
            >
              {t("system.auto_model_enable") || "启用自动模型"}
            </Button>
          )}
        </ProCard>

        {/* 模型选择器 */}
        <ProCard
          title={
            <span className="flex items-center gap-2">
              <Search size={16} />
              {t("system.auto_model_select_title") || "选择自动分流模型"}
            </span>
          }
          className="mb-4"
        >
          <p className="text-zinc-500 dark:text-zinc-400 text-sm mb-4">
            {t("system.auto_model_select_desc") || "从已发现的模型中选择要参与自动分流的模型，支持搜索和多选。"}
          </p>
          <div className="mb-4">
            <Select
              mode="multiple"
              style={{ width: "100%" }}
              placeholder={t("system.auto_model_select_placeholder") || "搜索并选择模型..."}
              value={selectedModels}
              onChange={setSelectedModels}
              loading={modelsLoading}
              showSearch
              filterOption={(input, option) =>
                String(option?.label ?? "").toLowerCase().includes(input.toLowerCase())
              }
              options={models.map((m) => ({
                value: m.modelId,
                label: `${m.modelId} (${m.platform.name})`,
              }))}
              notFoundContent={<Empty description={t("common.no_data") || "暂无数据"} />}
              maxTagCount="responsive"
              maxTagPlaceholder={(omittedValues) =>
                `+${omittedValues.length} ${t("common.items") || "项"}`
              }
            />
          </div>
          <div className="flex justify-end">
            <Button
              variant="primary"
              size="sm"
              onClick={saveSelectedModels}
              loading={selectedModelsLoading}
              disabled={selectedModels.length === 0}
            >
              {t("common.save") || "保存选择"}
            </Button>
          </div>
        </ProCard>

        {/* 已发现的模型列表 */}
        <ProCard
          title={
            <span className="flex items-center gap-2">
              <Database size={16} />
              {t("admin.auto_model_discovered") || "已发现的模型"}
            </span>
          }
        >
          <ResponsiveTable
            columns={columns}
            dataSource={models}
            rowKey="id"
            loading={modelsLoading}
            pagination={{ pageSize: 20, showTotal: (total) => t("common.pagination_total", { count: total }) }}
            scroll={{ x: 600 }}
          />
        </ProCard>
      </PageContainer>
    </AdminLayout>
  );
}
