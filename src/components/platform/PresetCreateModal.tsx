"use client";

import { useState } from "react";
import { useRouter } from "next/router";
import { useTranslation } from "react-i18next";
import { message, Modal, Input } from "antd";
import { Loader2 } from "lucide-react";
import type { PlatformPreset } from "@/lib/presets";
import { PresetIcon } from "@/components/platform/PresetIcon";

interface PresetCreateModalProps {
  /** 选中的预设；null 时隐藏 */
  preset: PlatformPreset | null;
  onClose: () => void;
  /** 创建成功回调（跳转详情页） */
  onCreated?: (platformId: string) => void;
}

interface PresetCreateModalInnerProps {
  /** 选中预设（由外层保证非 null） */
  preset: PlatformPreset;
  onClose: () => void;
  /** 创建成功回调（跳转详情页） */
  onCreated?: (platformId: string) => void;
}

/**
 * 从预设创建平台确认弹窗
 * - baseUrl 默认取预设地址，预设无默认地址时必填
 * - 密钥可选，创建后可在详情页补充
 *
 * 组件在父页面常驻挂载，preset 在 null ↔ 具体预设间切换时不会卸载；
 * 内部状态通过 key=<preset.id> 绑定预设重建，避免上次输入的
 * baseUrl/apiKeys 残留到下一个预设导致误提交。
 */
export function PresetCreateModal({ preset, onClose, onCreated }: PresetCreateModalProps) {
  if (!preset) return null;
  return (
    <PresetCreateModalInner
      key={preset.id}
      preset={preset}
      onClose={onClose}
      onCreated={onCreated}
    />
  );
}

function PresetCreateModalInner({ preset, onClose, onCreated }: PresetCreateModalInnerProps) {
  const { t } = useTranslation("platform");
  const router = useRouter();
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKeys, setApiKeys] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const needBaseUrl = !preset.baseUrl;

  const handleCreate = async () => {
    const finalBaseUrl = baseUrl.trim() || preset.baseUrl || "";
    if (!finalBaseUrl) {
      message.warning(t("presetBaseUrlRequired"));
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/platforms/from-preset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          presetId: preset.id,
          baseUrl: finalBaseUrl,
          apiKeys: apiKeys.trim() === "" ? undefined : JSON.stringify(apiKeys.trim().split("\n").filter(Boolean)),
        }),
      });
      const json = (await res.json()) as {
        success: boolean;
        error?: string;
        data?: { id: string; modelCount: number };
      };
      if (!res.ok || !json.success || !json.data) {
        throw new Error(json.error || t("presetCreateFailed"));
      }
      message.success(t("presetCreated", { count: json.data.modelCount }));
      onClose();
      onCreated?.(json.data.id);
      router.push(`/admin/platforms/${json.data.id}`);
    } catch (err) {
      message.error(String(err instanceof Error ? err.message : err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      title={t("presetCreateTitle")}
      onCancel={onClose}
      onOk={handleCreate}
      okText={t("presetCreate")}
      cancelText={t("back")}
      confirmLoading={submitting}
      centered
      width={480}
      style={{ maxWidth: "90vw" }}
    >
      <div className="flex items-center gap-3 pt-1 pb-3">
        <PresetIcon presetId={preset.id} size={36} />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
            {preset.name}
          </div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
            {t("presetModelCount", { count: preset.models.length })}
          </div>
        </div>
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-3">{t("presetCreateDesc")}</p>

      <div className="flex flex-col gap-3">
        <div>
          <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-300 mb-1">
            {t("baseUrl")}
            {needBaseUrl && <span className="text-red-500 ml-0.5">*</span>}
          </label>
          <Input
            size="small"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={preset.baseUrl ?? t("presetBaseUrlPlaceholder")}
            allowClear
          />
          {!needBaseUrl && (
            <p className="text-[11px] text-zinc-400 mt-1">{preset.baseUrl}</p>
          )}
        </div>
        <div>
          <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-300 mb-1">
            {t("presetKeysLabel")}
          </label>
          <Input.TextArea
            rows={3}
            size="small"
            value={apiKeys}
            onChange={(e) => setApiKeys(e.target.value)}
            placeholder={t("presetKeyPlaceholder")}
            className="font-mono text-xs"
          />
        </div>
      </div>

      {submitting && (
        <div className="flex items-center gap-2 mt-3 text-xs text-zinc-400">
          <Loader2 size={14} className="animate-spin" />
          {t("presetCreate")}…
        </div>
      )}
    </Modal>
  );
}