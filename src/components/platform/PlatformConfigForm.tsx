"use client";

import { useState } from "react";
import { Form, Input, InputNumber, Select, Popconfirm, Modal, Collapse } from "antd";
import { Button } from "@/components/ui/Button";
import Switch from "@/components/ui/Switch";
import {
  Plus,
  Copy,
  ShieldCheck,
  ShieldOff,
  Trash2,
  ClipboardPaste,
  AlertCircle,
  Settings,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { NamedApiKey } from "@/lib/platform";
import { BrandAvatar, StatusDot, type Platform } from "@/components/platform/PlatformList";

/**
 * 平台配置表单 — 单卡片可折叠，header 含品牌头像/名称/状态/启停开关
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
  onToggleKey,
  onSubmit,
  submitting,
  onDelete,
  deleting,
  onToggle,
  toggling,
  togglingKeyIndex,
  infoModalOpen,
  onInfoModalOpenChange,
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
  onToggleKey: (i: number, enabled: boolean) => void;
  onSubmit: () => void;
  submitting: boolean;
  onDelete: () => void;
  deleting: boolean;
  onToggle: (enabled: boolean) => void;
  toggling: boolean;
  togglingKeyIndex: number | null;
  infoModalOpen: boolean;
  onInfoModalOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("platform");

  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [batchText, setBatchText] = useState("");

  // 响应式读取表单字段值，供 Modal 中展示
  const formName = Form.useWatch("name", form);
  const formBaseUrl = Form.useWatch("baseUrl", form);
  const formType = Form.useWatch("type", form);

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

  const cardClass =
    "rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800";
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
    <Form form={form} layout="vertical" onFinish={onSubmit} className="space-y-4">
      {/* 单卡片：header(品牌+状态+开关) + 可折叠内容 */}
      <div className={cardClass}>
        {editing && (
          <div className="hidden lg:flex items-center gap-3 px-5 pt-5 pb-4 border-b border-zinc-100 dark:border-zinc-800">
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
            <button
              type="button"
              onClick={() => onInfoModalOpenChange(true)}
              className="shrink-0 p-2 rounded-lg text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:text-zinc-200 dark:hover:bg-zinc-800 transition-colors"
              title={t("groupBasic")}
            >
              <Settings size={16} />
            </button>
            <div className="shrink-0">
              <Switch checked={editing.enabled} loading={toggling} onChange={onToggle} />
            </div>
          </div>
        )}

        <Collapse
          defaultActiveKey={editing ? ["keys", "params"] : ["basic", "keys", "params"]}
          ghost
          className="platform-config-collapse px-3 sm:px-5 py-3 sm:py-4"
          items={[
            ...(!editing
              ? [
                  {
                    key: "basic",
                    label: <span className={groupTitle}>{t("groupBasic")}</span>,
                    children: (
                      <>
                        <Form.Item
                          name="name"
                          label={t("name")}
                          rules={[{ required: true }]}
                          extra={<span className={itemDesc}>{t("nameDesc")}</span>}
                          className="!mb-5"
                        >
                          <Input />
                        </Form.Item>
                        <Form.Item
                          name="baseUrl"
                          label={t("baseUrl")}
                          rules={[{ required: true }]}
                          extra={<span className={itemDesc}>{t("baseUrlDesc")}</span>}
                          className="!mb-5"
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
                      </>
                    ),
                  },
                ]
              : []),
            {
              key: "keys",
              label: <span className={groupTitle}>{t("apiKey")}</span>,
              children: (
                <>
                  <div className="space-y-2 mb-3">
                    {namedKeys.map((namedKey, index) => (
                      <div
                        key={index}
                        className="p-2 bg-zinc-50 dark:bg-zinc-800/50 rounded-lg border border-zinc-200 dark:border-zinc-700"
                      >
                        {/* 第一行：名称 + 密钥输入 */}
                        <div className="flex items-center gap-1.5">
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
                        </div>
                        {/* 第二行：操作按钮 */}
                        <div className="flex items-center gap-1 mt-1.5">
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
                        {editing && namedKey.key && (
                          <>
                            {namedKey.errorCount && namedKey.errorCount > 0 ? (
                              <span
                                className={`shrink-0 flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[10px] font-medium ${
                                  namedKey.enabled === false
                                    ? "text-red-600 bg-red-50 dark:text-red-400 dark:bg-red-900/30"
                                    : "text-orange-500 bg-orange-50 dark:text-orange-400 dark:bg-orange-900/20"
                                }`}
                                title={t("errorCountTip")}
                              >
                                <AlertCircle size={11} className="inline" />
                                {namedKey.errorCount}/5
                              </span>
                            ) : null}
                            <Switch
                              checked={namedKey.enabled !== false}
                              loading={togglingKeyIndex === index}
                              onChange={(checked) => onToggleKey(index, checked)}
                              className="!h-[20px] !w-[36px]"
                            />
                          </>
                        )}
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
                </>
              ),
            },
            {
              key: "params",
              label: <span className={groupTitle}>{t("groupParams")}</span>,
              children: (
                <>
                  <div className="grid grid-cols-2 gap-x-4">
                    <Form.Item
                      name="priority"
                      label={t("priority")}
                      extra={<span className={itemDesc}>{t("priorityDesc")}</span>}
                      className="!mb-5"
                    >
                      <InputNumber min={0} className="!w-full" />
                    </Form.Item>
                    <Form.Item
                      name="weight"
                      label={t("weight")}
                      extra={<span className={itemDesc}>{t("weightDesc")}</span>}
                      className="!mb-5"
                    >
                      <InputNumber min={1} className="!w-full" />
                    </Form.Item>
                    <Form.Item
                      name="rpmLimit"
                      label={t("rpmLimit")}
                      extra={<span className={itemDesc}>{t("rpmDesc")}</span>}
                      className="!mb-5"
                    >
                      <InputNumber min={0} placeholder={t("common:unlimited")} className="!w-full" />
                    </Form.Item>
                    <Form.Item
                      name="tpmLimit"
                      label={t("tpmLimit")}
                      extra={<span className={itemDesc}>{t("tpmDesc")}</span>}
                      className="!mb-5"
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
                </>
              ),
            },
          ]}
        />
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

      {/* 基本信息 Modal（齿轮按钮打开，仅编辑已有平台时显示） */}
      <Modal
        title={t("groupBasic")}
        open={infoModalOpen}
        onCancel={() => onInfoModalOpenChange(false)}
        onOk={() => onInfoModalOpenChange(false)}
        okText={t("common:save")}
        cancelText={t("common:cancel")}
        width="min(90vw, 640px)"
      >
        <div className="pt-2 space-y-5">
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
              {t("name")} <span className="text-red-500">*</span>
            </label>
            <Input
              value={formName ?? ""}
              onChange={(e) => form.setFieldsValue({ name: e.target.value })}
            />
            <p className="text-xs text-zinc-400 mt-1">{t("nameDesc")}</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
              {t("baseUrl")} <span className="text-red-500">*</span>
            </label>
            <Input
              value={formBaseUrl ?? ""}
              onChange={(e) => form.setFieldsValue({ baseUrl: e.target.value })}
              placeholder="https://api.openai.com/v1"
            />
            <p className="text-xs text-zinc-400 mt-1">{t("baseUrlDesc")}</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
              {t("type")}
            </label>
            <Select
              value={formType}
              onChange={(v) => form.setFieldsValue({ type: v })}
              options={[
                { value: "openai", label: t("typeOpenai") },
                { value: "azure", label: t("typeAzure") },
                { value: "custom", label: t("typeCustom") },
              ]}
              className="w-full"
            />
            <p className="text-xs text-zinc-400 mt-1">{t("typeDesc")}</p>
          </div>
        </div>
      </Modal>

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
