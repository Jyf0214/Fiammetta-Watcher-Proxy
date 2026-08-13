"use client";

import { useState } from "react";
import { Form, Input, InputNumber, Select, Popconfirm, Modal } from "antd";
import { Button } from "@/components/ui/Button";
import Switch from "@/components/ui/Switch";
import {
  Plus,
  Copy,
  ShieldCheck,
  ShieldOff,
  Trash2,
  ClipboardPaste,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { NamedApiKey } from "@/lib/platform";
import { BrandAvatar, StatusDot, type Platform } from "@/components/platform/PlatformList";

/**
 * 平台配置表单 — 白卡 + 细边框 + 轻阴影 + 字段说明
 * 首个卡片头部 = 品牌图标 + 名称 + 状态 + 启停开关（桌面端，移动端由返回条承担）
 */
export function PlatformConfigForm({
  form,
  editing,
  namedKeys,
  onAddKey,
  onBatchAddKeys,
  onRemoveKey,
  onUpdateKeyName,
  onUpdateKeyValue,
  onCopyKey,
  onToggleWhitelist,
  onSubmit,
  submitting,
  onDelete,
  deleting,
  onToggle,
  toggling,
}: {
  form: ReturnType<typeof Form.useForm>[0];
  editing: Platform | null;
  namedKeys: NamedApiKey[];
  onAddKey: () => void;
  onBatchAddKeys: (keys: string[]) => void;
  onRemoveKey: (i: number) => void;
  onUpdateKeyName: (i: number, v: string) => void;
  onUpdateKeyValue: (i: number, v: string) => void;
  onCopyKey: (k: string) => void;
  onToggleWhitelist: (i: number) => void;
  onSubmit: () => void;
  submitting: boolean;
  onDelete: () => void;
  deleting: boolean;
  onToggle: (enabled: boolean) => void;
  toggling: boolean;
}) {
  const { t } = useTranslation("platform");

  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [batchText, setBatchText] = useState("");

  const handleBatchSubmit = () => {
    const lines = batchText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length > 0) {
      onBatchAddKeys(lines);
    }
    setBatchText("");
    setBatchModalOpen(false);
  };

  const formGroup =
    "rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-5 sm:p-6";
  const groupTitle =
    "text-xs font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider mb-4";
  const itemDesc = "text-xs text-zinc-400 dark:text-zinc-500";

  const statusLabel = !editing
    ? ""
    : editing.status === "healthy"
    ? t("statusHealthy")
    : editing.status === "degraded"
    ? t("statusDegraded")
    : t("statusDown");

  return (
    <Form form={form} layout="vertical" onFinish={onSubmit} className="space-y-5">
      {/* 组 1：基本信息 */}
      <div className={formGroup}>
        {editing && (
          <div className="hidden lg:flex items-center gap-3 pb-5 mb-5 border-b border-zinc-100 dark:border-zinc-800">
            <BrandAvatar name={editing.name} type={editing.type} size="lg" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-[15px] font-bold text-zinc-900 dark:text-zinc-100 truncate">
                  {editing.name}
                </h2>
                <StatusDot status={editing.status} enabled={editing.enabled} />
                <span className="text-[11px] text-zinc-400">
                  {editing.enabled ? statusLabel : t("common:disable")}
                </span>
              </div>
            </div>
            <div className="shrink-0">
              <Switch checked={editing.enabled} loading={toggling} onChange={onToggle} />
            </div>
          </div>
        )}
        <h3 className={groupTitle}>{t("groupBasic")}</h3>
        <Form.Item
          name="name"
          label={t("name")}
          rules={[{ required: true }]}
          extra={<span className={itemDesc}>{t("nameDesc")}</span>}
          className="!mb-6"
        >
          <Input />
        </Form.Item>
        <Form.Item
          name="baseUrl"
          label={t("baseUrl")}
          rules={[{ required: true }]}
          extra={<span className={itemDesc}>{t("baseUrlDesc")}</span>}
          className="!mb-6"
        >
          <Input placeholder="https://api.openai.com/v1" />
        </Form.Item>
        <Form.Item
          name="type"
          label={t("type")}
          extra={<span className={itemDesc}>{t("typeDesc")}</span>}
          className="!mb-0"
        >
          <Select
            options={[
              { value: "openai", label: t("typeOpenai") },
              { value: "azure", label: t("typeAzure") },
              { value: "custom", label: t("typeCustom") },
            ]}
          />
        </Form.Item>
      </div>

      {/* 组 2：API 密钥 */}
      <div className={formGroup}>
        <h3 className={groupTitle}>{t("apiKey")}</h3>
        <div className="space-y-2 mb-3">
          {namedKeys.map((namedKey, index) => (
            <div
              key={index}
              className="flex items-center gap-1.5 p-2 bg-zinc-50 dark:bg-zinc-800/50 rounded-xl border border-zinc-200 dark:border-zinc-700"
            >
              <Input
                value={namedKey.name}
                onChange={(e) => onUpdateKeyName(index, e.target.value)}
                placeholder={t("keyName")}
                className="!w-20 sm:!w-24 !min-w-0 shrink-0"
                size="small"
              />
              <Input.Password
                value={namedKey.key}
                onChange={(e) => onUpdateKeyValue(index, e.target.value)}
                placeholder={editing ? t("keyPlaceholderEdit") : t("keyPlaceholderAdd")}
                className="!flex-1 !min-w-0 font-mono text-xs"
                size="small"
              />
              <button
                type="button"
                onClick={() => onToggleWhitelist(index)}
                disabled={!namedKey.key}
                title={namedKey.whitelisted ? t("whitelistRemoveTip") : t("whitelistAddTip")}
                className={`shrink-0 p-1.5 sm:px-2 sm:py-1 rounded-md text-[11px] font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                  namedKey.whitelisted
                    ? "text-amber-600 bg-amber-50 dark:text-amber-400 dark:bg-amber-900/30"
                    : "text-zinc-400 hover:text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/20"
                }`}
              >
                {namedKey.whitelisted ? <ShieldCheck size={14} className="inline" /> : <ShieldOff size={14} className="inline" />}
                <span className="hidden sm:inline ml-0.5">
                  {namedKey.whitelisted ? t("whitelistRemove") : t("whitelistAdd")}
                </span>
              </button>
              <button
                type="button"
                onClick={() => onCopyKey(namedKey.key)}
                disabled={!namedKey.key}
                className="shrink-0 p-1.5 rounded-md text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                title={t("copyKeyTip")}
              >
                <Copy size={13} />
              </button>
              <button
                type="button"
                onClick={() => onRemoveKey(index)}
                disabled={namedKeys.length <= 1}
                className="shrink-0 p-1.5 rounded-md text-zinc-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                title={t("removeKeyTip")}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <div className="border-t border-zinc-200/70 dark:border-zinc-700/50 pt-3 flex gap-2">
          <Button variant="default" onClick={onAddKey} icon={<Plus size={14} />} block size="sm">
            {t("addKey")}
          </Button>
          <Button
            variant="ghost"
            onClick={() => setBatchModalOpen(true)}
            icon={<ClipboardPaste size={14} />}
            block
            size="sm"
          >
            {t("batchAddKey")}
          </Button>
        </div>
      </div>

      {/* 批量添加密钥模态框 */}
      <Modal
        title={t("batchAddKey")}
        open={batchModalOpen}
        onCancel={() => {
          setBatchText("");
          setBatchModalOpen(false);
        }}
        onOk={handleBatchSubmit}
        okText={t("common:add")}
        cancelText={t("common:cancel")}
      >
        <Input.TextArea
          value={batchText}
          onChange={(e) => setBatchText(e.target.value)}
          rows={10}
          placeholder={t("batchAddKeyPlaceholder")}
          className="font-mono text-xs"
        />
        <p className="text-xs text-zinc-400 mt-2">{t("batchAddKeyHint")}</p>
      </Modal>

      {/* 组 3：参数设置 */}
      <div className={formGroup}>
        <h3 className={groupTitle}>{t("groupParams")}</h3>
        <div className="grid grid-cols-2 gap-x-4">
          <Form.Item
            name="priority"
            label={t("priority")}
            extra={<span className={itemDesc}>{t("priorityDesc")}</span>}
            className="!mb-6"
          >
            <InputNumber min={0} className="!w-full" />
          </Form.Item>
          <Form.Item
            name="weight"
            label={t("weight")}
            extra={<span className={itemDesc}>{t("weightDesc")}</span>}
            className="!mb-6"
          >
            <InputNumber min={1} className="!w-full" />
          </Form.Item>
          <Form.Item
            name="rpmLimit"
            label={t("rpmLimit")}
            extra={<span className={itemDesc}>{t("rpmDesc")}</span>}
            className="!mb-6"
          >
            <InputNumber min={0} placeholder={t("common:unlimited")} className="!w-full" />
          </Form.Item>
          <Form.Item
            name="tpmLimit"
            label={t("tpmLimit")}
            extra={<span className={itemDesc}>{t("tpmDesc")}</span>}
            className="!mb-6"
          >
            <InputNumber min={0} placeholder={t("common:unlimited")} className="!w-full" />
          </Form.Item>
        </div>
        <Form.Item
          name="forwardHeaders"
          label={t("forwardHeaders")}
          extra={<span className={itemDesc}>{t("forwardHeadersDesc")}</span>}
          className="!mb-0"
        >
          <Input.TextArea
            rows={2}
            placeholder={t("forwardHeadersPlaceholder")}
          />
        </Form.Item>
        <Form.Item
          name="injectStreamOptions"
          label={t("injectStreamOptions")}
          valuePropName="checked"
          extra={<span className={itemDesc}>{t("injectStreamOptionsDesc")}</span>}
          className="!mt-4 !mb-0"
        >
          <Switch />
        </Form.Item>
      </div>

      {/* 操作区 */}
      <div className="flex items-center justify-between pt-1">
        {editing ? (
          <Popconfirm
            title={t("deletePlatform")}
            description={t("deletePlatformDesc")}
            onConfirm={onDelete}
            okText={t("common:confirm")}
            cancelText={t("common:cancel")}
            okButtonProps={{ danger: true }}
          >
            <button
              type="button"
              disabled={deleting}
              className="text-xs text-red-500 hover:text-red-600 disabled:opacity-50 transition-colors"
            >
              {deleting ? t("common:loading") : t("deletePlatform")}
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
          {submitting ? t("common:loading") : editing ? t("common:save") : t("common:create")}
        </Button>
      </div>
    </Form>
  );
}