"use client";

import { Form, Input, InputNumber, Select, Popconfirm } from "antd";
import { Button } from "@/components/ui/Button";
import {
  Plus,
  Copy,
  ShieldCheck,
  ShieldOff,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  BASE_URL_PRESETS,
  type NamedApiKey,
} from "@/lib/platform";
import type { Platform } from "@/components/platform/PlatformList";

/** 与浅灰卡片组融合的扁平输入框样式（聚焦时显示浅色边框） */
const FLAT_INPUT = "!bg-transparent !border-transparent hover:!border-transparent focus:!border-zinc-300 dark:focus:!border-zinc-600 focus:!shadow-none rounded-lg";

/**
 * 平台配置表单 — Lobe 风格：浅灰大圆角表单卡片组 + 快捷填充胶囊
 */
export function PlatformConfigForm({
  form,
  editing,
  namedKeys,
  onAddKey,
  onRemoveKey,
  onUpdateKeyName,
  onUpdateKeyValue,
  onCopyKey,
  onToggleWhitelist,
  onSubmit,
  submitting,
  onDelete,
  deleting,
}: {
  form: ReturnType<typeof Form.useForm>[0];
  editing: Platform | null;
  namedKeys: NamedApiKey[];
  onAddKey: () => void;
  onRemoveKey: (i: number) => void;
  onUpdateKeyName: (i: number, v: string) => void;
  onUpdateKeyValue: (i: number, v: string) => void;
  onCopyKey: (k: string) => void;
  onToggleWhitelist: (i: number) => void;
  onSubmit: () => void;
  submitting: boolean;
  onDelete: () => void;
  deleting: boolean;
}) {
  const { t } = useTranslation();

  const formGroup = "rounded-2xl bg-zinc-50 dark:bg-zinc-800/50 p-4";
  const groupTitle = "text-xs font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider mb-2";

  return (
    <Form form={form} layout="vertical" onFinish={onSubmit} className="space-y-4">
      {/* 组 1：基本信息 */}
      <div className={formGroup}>
        <h3 className={groupTitle}>{t("platform.group_basic")}</h3>
        <Form.Item name="name" label={t("platform.name")} rules={[{ required: true }]} className="!mb-3">
          <Input className={FLAT_INPUT} />
        </Form.Item>
        <Form.Item name="baseUrl" label={t("platform.base_url")} rules={[{ required: true }]} className="!mb-3">
          <Input placeholder="https://api.openai.com/v1" className={FLAT_INPUT} />
        </Form.Item>
        {/* 快捷填充胶囊 */}
        <div className="flex gap-1.5 overflow-x-auto pb-1 -mt-1 mb-3">
          {BASE_URL_PRESETS.map((url) => (
            <button
              key={url}
              type="button"
              onClick={() => form.setFieldValue("baseUrl", url)}
              className="shrink-0 px-2.5 py-1 rounded-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-[11px] text-zinc-500 dark:text-zinc-400 hover:border-zinc-300 dark:hover:border-zinc-600 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors"
            >
              {new URL(url).host}
            </button>
          ))}
        </div>
        <Form.Item name="type" label={t("platform.type")} className="!mb-0">
          <Select
            variant="borderless"
            options={[
              { value: "openai", label: "OpenAI" },
              { value: "azure", label: "Azure" },
              { value: "custom", label: "Custom" },
            ]}
            className="!bg-transparent"
          />
        </Form.Item>
      </div>

      {/* 组 2：API 密钥 */}
      <div className={formGroup}>
        <h3 className={groupTitle}>{t("platform.api_key")}</h3>
        <div className="space-y-2 mb-3">
          {namedKeys.map((namedKey, index) => (
            <div
              key={index}
              className="flex items-center gap-1.5 p-2 bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700"
            >
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
                placeholder={editing ? "清空将移除该密钥" : "输入 API 密钥"}
                className="!flex-1 !min-w-0 font-mono text-xs"
                size="small"
              />
              <button
                type="button"
                onClick={() => onToggleWhitelist(index)}
                disabled={!namedKey.key}
                className={`shrink-0 p-1.5 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                  namedKey.whitelisted
                    ? "text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/20"
                    : "text-zinc-400 hover:text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/20"
                }`}
                title={namedKey.whitelisted ? "白名单（点击移除）" : "加入白名单（429 时不封禁）"}
              >
                {namedKey.whitelisted ? <ShieldCheck size={13} /> : <ShieldOff size={13} />}
              </button>
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
        </div>
        <Button variant="default" onClick={onAddKey} icon={<Plus size={14} />} block size="sm">
          {t("platform.add_key")}
        </Button>
      </div>

      {/* 组 3：参数设置 */}
      <div className={formGroup}>
        <h3 className={groupTitle}>{t("platform.group_params")}</h3>
        <div className="grid grid-cols-2 gap-x-4">
          <Form.Item name="priority" label={t("platform.priority")} className="!mb-3">
            <InputNumber min={0} className={`!w-full ${FLAT_INPUT}`} />
          </Form.Item>
          <Form.Item name="weight" label={t("platform.weight")} className="!mb-3">
            <InputNumber min={1} className={`!w-full ${FLAT_INPUT}`} />
          </Form.Item>
          <Form.Item name="rpmLimit" label={t("platform.rpm_limit")} className="!mb-3">
            <InputNumber min={0} placeholder={t("common.unlimited")} className={`!w-full ${FLAT_INPUT}`} />
          </Form.Item>
          <Form.Item name="tpmLimit" label={t("platform.tpm_limit")} className="!mb-3">
            <InputNumber min={0} placeholder={t("common.unlimited")} className={`!w-full ${FLAT_INPUT}`} />
          </Form.Item>
        </div>
        <Form.Item name="forwardHeaders" label={t("platform.forward_headers")} className="!mb-0">
          <Input.TextArea
            rows={2}
            placeholder={"每行一个 Header 名称\nX-Thinking-Mode\nX-Reasoning-Effort"}
            className={FLAT_INPUT}
          />
        </Form.Item>
      </div>

      {/* 操作区 */}
      <div className="flex items-center justify-between pt-1">
        {editing ? (
          <Popconfirm
            title={t("platform.delete_platform")}
            description={t("platform.delete_platform_desc")}
            onConfirm={onDelete}
            okText={t("common.confirm")}
            cancelText={t("common.cancel")}
            okButtonProps={{ danger: true }}
          >
            <button
              type="button"
              disabled={deleting}
              className="text-xs text-red-500 hover:text-red-600 disabled:opacity-50 transition-colors"
            >
              {deleting ? t("common.loading") : t("platform.delete_platform")}
            </button>
          </Popconfirm>
        ) : (
          <span />
        )}
        <Button
          variant="primary"
          type="submit"
          disabled={submitting}
          autoLoading={false}
        >
          {submitting ? t("common.loading") : editing ? t("common.save") : t("common.create")}
        </Button>
      </div>
    </Form>
  );
}
