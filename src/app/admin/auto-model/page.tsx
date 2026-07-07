"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Tag, message, Tooltip } from "antd";
import { Button } from "@/components/ui/Button";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { Zap, Copy, Check, RefreshCw, Database } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";

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

  /** 获取自动模型 ID 配置 */
  const fetchAutoModelId = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/config");
      const data = await res.json();
      if (data.success && data.data) {
        setAutoModelId(data.data["system:auto_model_id"] || null);
      }
    } catch {
      // 静默失败
    }
  }, []);

  /** 获取所有平台已发现的模型列表 */
  const fetchAllModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      const res = await fetch("/api/admin/platforms");
      const data = await res.json();
      if (!data.success || !Array.isArray(data.data)) return;

      const allModels: PlatformModel[] = [];
      for (const platform of data.data) {
        try {
          const mRes = await fetch(`/api/admin/platforms/${platform.id}/models`);
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
    } catch {
      message.error(t("common.error"));
    } finally {
      setModelsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchAutoModelId();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchAllModels();
  }, [fetchAutoModelId, fetchAllModels]);

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
        <Tag color={v === "manual" ? "green" : "blue"}>
          {v === "manual" ? "手动" : "自动"}
        </Tag>
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
    <div>
      <div className="border-b border-zinc-100 dark:border-zinc-800 pb-4 mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mb-2">
          <span className="flex items-center gap-2">
            <Zap size={22} />
            {t("admin.auto_model")}
          </span>
        </h1>
        <p className="text-zinc-500 dark:text-zinc-400">
          {t("admin.auto_model_desc")}
        </p>
      </div>

      {/* 自动模型 ID 配置 */}
      <Card
        className="rounded-2xl shadow-sm border border-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 mb-6"
        title={
          <span className="flex items-center gap-2">
            <Zap size={18} />
            {t("system.auto_model_title") || "自动模型"}
          </span>
        }
      >
        <p className="text-zinc-500 dark:text-zinc-400 text-sm mb-4">
          {t("system.auto_model_desc") || "配置后，请求此模型 ID 时将自动轮询所有可用平台。"}
        </p>
        {autoModelId ? (
          <div className="flex items-center gap-3">
            <code className="flex-1 bg-zinc-100 dark:bg-zinc-800 px-3 py-2 rounded text-sm font-mono break-all">
              {autoModelId}
            </code>
            <Tooltip title={copied ? t("common.copied") : t("common.copy")}>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={copied ? <Check size={14} /> : <Copy size={14} />}
                onClick={copyAutoModelId}
              />
            </Tooltip>
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
      </Card>

      {/* 已发现的模型列表 */}
      <Card
        className="rounded-2xl shadow-sm border border-zinc-100 dark:border-zinc-800 dark:bg-zinc-900"
        title={
          <span className="flex items-center gap-2">
            <Database size={18} />
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
      </Card>
    </div>
  );
}
