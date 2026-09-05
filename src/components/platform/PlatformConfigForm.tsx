"use client";

import { useState, useCallback, memo } from "react";
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
  Link2,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { NamedApiKey } from "@/lib/platform";
import { BrandAvatar, StatusDot, type Platform } from "@/components/platform/PlatformList";
import type { PlatformType } from "@/lib/types";

/** 单平台多协议：把 form 里的"首选单选 + 附加多选"合并为 types[] 提交给 API。
 *  首选协议 = type（始终放数组第一位），附加协议 = additionalTypes（去重、首项剔除）。
 *  返回值形态与 lib/types.ts PlatformProtocol[] 一致；空数组时回退到 [type]。 */
function buildPlatformTypesForSubmit(
  type: PlatformType | undefined,
  additionalTypes: PlatformType[] | undefined
): PlatformType[] {
  const primary: PlatformType = (type as PlatformType) || "openai";
  const extras = (additionalTypes ?? []).filter(
    (p): p is PlatformType =>
      p !== primary &&
      (p === "openai" || p === "azure" || p === "custom" || p === "anthropic" || p === "gemini")
  );
  // 去重保序
  const seen = new Set<PlatformType>();
  const result: PlatformType[] = [];
  for (const p of [primary, ...extras]) {
    if (!seen.has(p)) {
      seen.add(p);
      result.push(p);
    }
  }
  return result;
}

/**
 * 单把密钥编辑行 — memo 化：页面层回调全部为稳定引用，密钥输入每次击键
 * 只重渲染当前行，其余行经 props 浅比较跳过（大密钥量下输入卡顿的根因修复）
 */
const NamedKeyRow = memo(function NamedKeyRow({
  namedKey,
  index,
  editing,
  canRemove,
  busy,
  proxyOpen,
  hasProxyChoices,
  availableProxyUrls,
  onUpdateName,
  onUpdateValue,
  onCopyKey,
  onToggleWhitelist,
  onToggleKey,
  onRemove,
  onToggleProxyPanel,
  onUpdateProxyUrls,
  onUpdateProxyStrict,
}: {
  namedKey: NamedApiKey;
  index: number;
  editing: boolean;
  /** 列表多于一把时才允许删除 */
  canRemove: boolean;
  /** 该行启停开关请求进行中 */
  busy: boolean;
  /** 该行代理绑定面板是否展开 */
  proxyOpen: boolean;
  /** 部署存在可用代理 URL（决定绑定入口显隐） */
  hasProxyChoices: boolean;
  availableProxyUrls: Array<{ url: string; group: string; enabled: boolean }>;
  onUpdateName: (i: number, v: string) => void;
  onUpdateValue: (i: number, v: string) => void;
  onCopyKey: (k: string) => void;
  onToggleWhitelist: (i: number) => void;
  onToggleKey: (i: number, enabled: boolean) => void;
  onRemove: (i: number) => void;
  onToggleProxyPanel: (i: number) => void;
  onUpdateProxyUrls: (i: number, urls: string[]) => void;
  onUpdateProxyStrict: (i: number, strict: boolean) => void;
}) {
  const { t } = useTranslation("platform");
  return (
    <div
      className="p-2 bg-zinc-50 dark:bg-zinc-800/50 rounded-lg border border-zinc-200 dark:border-zinc-700"
    >
      {/* 第一行：名称 + 密钥输入 */}
      <div className="flex items-center gap-1.5">
        <Input
          value={namedKey.name}
          onChange={(e) => onUpdateName(index, e.target.value)}
          placeholder={t("keyName")}
          className="!w-20 sm:!w-24 !min-w-0 shrink-0"
          size="small"
        />
        <Input.Password
          value={namedKey.key}
          onChange={(e) => onUpdateValue(index, e.target.value)}
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
            loading={busy}
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
        onClick={() => onRemove(index)}
        disabled={!canRemove}
        className="shrink-0 p-1.5 rounded-md text-zinc-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        title={t("removeKeyTip")}
      >
        <Trash2 size={13} />
      </button>
      {hasProxyChoices && (
        <button
          type="button"
          onClick={() => onToggleProxyPanel(index)}
          disabled={!namedKey.key}
          className={`shrink-0 p-1.5 sm:px-2 sm:py-1 rounded-md text-[11px] font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
            namedKey.proxyUrls && namedKey.proxyUrls.length > 0
              ? "text-blue-600 bg-blue-50 dark:text-blue-400 dark:bg-blue-900/30"
              : "text-zinc-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20"
          }`}
          title={t("proxyBindTip")}
        >
          <Link2 size={14} className="inline" />
          <span className="hidden sm:inline ml-0.5">{t("proxyBind")}</span>
        </button>
      )}
      </div>
      {/* 代理绑定面板（可折叠） */}
      {proxyOpen && (
        <div className="mt-2 pt-2 border-t border-zinc-200/60 dark:border-zinc-700/40 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-zinc-500 dark:text-zinc-400 shrink-0">{t("proxyBindLabel")}</span>
            <Select
              mode="multiple"
              size="small"
              value={namedKey.proxyUrls ?? []}
              onChange={(v: string[]) => onUpdateProxyUrls(index, v.slice(0, 2))}
              maxTagCount={2}
              placeholder={t("proxyBindPlaceholder")}
              className="flex-1"
              options={availableProxyUrls.map((p) => ({
                value: p.url,
                label: (
                  <span className="flex items-center gap-1.5 text-xs">
                    <span className="truncate max-w-[180px]">{p.url.replace(/^https?:\/\//, "").replace(/\/\/.*@/, "//***@")}</span>
                    <span className="text-[10px] text-zinc-400 shrink-0">{p.group}</span>
                    {!p.enabled && <span className="text-[10px] text-orange-400 shrink-0">off</span>}
                  </span>
                ),
              }))}
              disabled={!namedKey.key}
              maxTagPlaceholder={(omitted) => `+${omitted.length}`}
            />
          </div>
          {namedKey.proxyUrls && namedKey.proxyUrls.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-zinc-500 dark:text-zinc-400 shrink-0">{t("proxyStrictLabel")}</span>
              <Switch
                checked={namedKey.proxyStrict !== false}
                onChange={(checked) => onUpdateProxyStrict(index, checked)}
                className="!h-[18px] !w-[32px]"
              />
              <span className="text-[10px] text-zinc-400 dark:text-zinc-500">
                {namedKey.proxyStrict !== false ? t("proxyStrictOn") : t("proxyStrictOff")}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

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
  onUpdateKeyProxyUrls,
  onUpdateKeyProxyStrict,
  availableProxyUrls,
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
  onUpdateKeyProxyUrls: (i: number, urls: string[]) => void;
  onUpdateKeyProxyStrict: (i: number, strict: boolean) => void;
  availableProxyUrls: Array<{ url: string; group: string; enabled: boolean }>;
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
  const [expandedProxyIndex, setExpandedProxyIndex] = useState<number | null>(null);

  // 删除密钥行时同步修正展开态：expandedProxyIndex 按位置索引记录，
  // 删除位之前的行被移除后后续行前移，若不修正，代理绑定面板会错位到另一把密钥
  const handleRemoveKey = useCallback((index: number) => {
    setExpandedProxyIndex((prev) => {
      if (prev === null || index > prev) return prev;
      if (index === prev) return null;
      return prev - 1;
    });
    onRemoveKey(index);
  }, [onRemoveKey]);

  // 代理绑定面板展开/收起（稳定引用供 memo 密钥行使用）
  const toggleProxyPanel = useCallback((index: number) => {
    setExpandedProxyIndex((prev) => (prev === index ? null : index));
  }, []);

  // 认证类/协议管控头禁止透传（与代理层 FORBIDDEN_FORWARD_HEADERS 双端一致，W7）：
  // 透传白名单可覆盖平台密钥，导致 401 封禁循环或 BYOK 绕过计费
  const FORBIDDEN_FORWARD_HEADERS = [
    "authorization",
    "proxy-authorization",
    "x-api-key",
    "x-auth-token",
    "cookie",
    "content-type",
    "content-length",
    "host",
    "connection",
    "transfer-encoding",
    "upgrade",
    "expect",
    // 与代理层 FORBIDDEN_FORWARD_HEADERS 三端（Worker 全量/lite/Pages v1）一致
    "x-forwarded-for",
    "x-forwarded-proto",
    "x-forwarded-host",
    "x-real-ip",
    "cf-connecting-ip",
    "eo-client-ip",
    "eo-connecting-ip",
    "x-vercel-forwarded-for",
  ];

  const validateForwardHeaders = (_: unknown, value: string | undefined): Promise<void> => {
    if (!value || value.trim() === "") return Promise.resolve();
    const forbidden = value
      .split("\n")
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean)
      .filter((h) => FORBIDDEN_FORWARD_HEADERS.includes(h));
    if (forbidden.length > 0) {
      return Promise.reject(
        new Error(t("forwardHeadersForbidden", { names: forbidden.join(", ") }))
      );
    }
    return Promise.resolve();
  };

  // extraHeaders 序列化器会静默跳过格式非法的行（缺冒号/空值），保存后配置
  // 无声丢失且无报错可排查——提交前显式校验并列出非法行号
  const validateExtraHeaders = (_: unknown, value: string | undefined): Promise<void> => {
    if (!value || value.trim() === "") return Promise.resolve();
    const invalidLines: number[] = [];
    value.split("\n").forEach((line, i) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const idx = trimmed.indexOf(":");
      const key = idx > 0 ? trimmed.slice(0, idx).trim() : "";
      const val = idx > 0 ? trimmed.slice(idx + 1).trim() : "";
      if (idx <= 0 || !key || !val) invalidLines.push(i + 1);
    });
    if (invalidLines.length > 0) {
      return Promise.reject(
        new Error(t("extraHeadersInvalid", { lines: invalidLines.join(", ") }))
      );
    }
    return Promise.resolve();
  };

  // 响应式读取：条件渲染 customUserAgent 必须用 useWatch——
  // getFieldValue 是快照读取，不会触发重渲染（开关切换后输入框不出现/不消失）
  const formReuseUserAgent = Form.useWatch("reuseUserAgent", form);

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
          <div className="hidden lg:flex items-center gap-3 px-5 sm:px-6 pt-5 sm:pt-6 pb-5 mb-5 border-b border-zinc-100 dark:border-zinc-800">
            <BrandAvatar name={editing.name} type={editing.type} presetId={editing.presetId} size="lg" />
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
          className="platform-config-collapse p-5 sm:p-6"
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
                              { value: "anthropic", label: t("typeAnthropic") },
                              { value: "azure", label: t("typeAzure") },
                              { value: "custom", label: t("typeCustom") },
                              { value: "gemini", label: t("typeGemini") },
                            ]}
                          />
                        </Form.Item>
                        <Form.Item
                          shouldUpdate={(prev, curr) =>
                            prev.type !== curr.type ||
                            JSON.stringify(prev.additionalTypes) !== JSON.stringify(curr.additionalTypes)
                          }
                          noStyle
                        >
                          {({ getFieldValue, setFieldValue }) => {
                            const primary = getFieldValue("type") as PlatformType | undefined;
                            const addExtras = (delta: { value: string; label: string }[]) => {
                              const cur = (getFieldValue("additionalTypes") as PlatformType[] | undefined) ?? [];
                              const next: PlatformType[] = [];
                              const seen = new Set<PlatformType>();
                              for (const p of [...cur, ...delta.map((d) => d.value as PlatformType)]) {
                                if (p !== primary && !seen.has(p)) {
                                  seen.add(p);
                                  next.push(p);
                                }
                              }
                              setFieldValue("additionalTypes", next);
                            };
                            const removeExtra = (p: PlatformType) => {
                              const cur = (getFieldValue("additionalTypes") as PlatformType[] | undefined) ?? [];
                              setFieldValue(
                                "additionalTypes",
                                cur.filter((x) => x !== p)
                              );
                            };
                            const moveExtra = (p: PlatformType, dir: -1 | 1) => {
                              const cur = (getFieldValue("additionalTypes") as PlatformType[] | undefined) ?? [];
                              const idx = cur.indexOf(p);
                              if (idx < 0) return;
                              const swap = idx + dir;
                              if (swap < 0 || swap >= cur.length) return;
                              const next = [...cur];
                              [next[idx], next[swap]] = [next[swap], next[idx]];
                              setFieldValue("additionalTypes", next);
                            };
                            const extras = (getFieldValue("additionalTypes") as PlatformType[] | undefined) ?? [];
                            return (
                              <Form.Item
                                name="additionalTypes"
                                label={t("additionalTypes")}
                                extra={<span className={itemDesc}>{t("additionalTypesDesc")}</span>}
                                className="!mt-5"
                              >
                                <Select
                                  mode="multiple"
                                  placeholder={t("additionalTypesPlaceholder")}
                                  value={extras}
                                  onChange={(_v, option) => addExtras(option as { value: string; label: string }[])}
                                  tagRender={(props) => {
                                    const value = props.value as PlatformType;
                                    const idx = extras.indexOf(value);
                                    const labelText =
                                      value === "openai" ? t("typeOpenai") :
                                      value === "anthropic" ? t("typeAnthropic") :
                                      value === "azure" ? t("typeAzure") :
                                      value === "custom" ? t("typeCustom") :
                                      value === "gemini" ? t("typeGemini") : value;
                                    return (
                                      <span
                                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-200/60 dark:border-blue-800/60 mr-1"
                                      >
                                        <span className="text-[10px] text-blue-500/80 dark:text-blue-400/80 tabular-nums">{idx + 1}</span>
                                        <span>{labelText}</span>
                                        <button
                                          type="button"
                                          aria-label="up"
                                          onMouseDown={(e) => { e.preventDefault(); moveExtra(value, -1); }}
                                          disabled={idx <= 0}
                                          className="ml-0.5 text-blue-500 hover:text-blue-700 disabled:opacity-30"
                                        ><ArrowUp size={10} /></button>
                                        <button
                                          type="button"
                                          aria-label="down"
                                          onMouseDown={(e) => { e.preventDefault(); moveExtra(value, 1); }}
                                          disabled={idx < 0 || idx >= extras.length - 1}
                                          className="text-blue-500 hover:text-blue-700 disabled:opacity-30"
                                        ><ArrowDown size={10} /></button>
                                        <button
                                          type="button"
                                          aria-label="remove"
                                          onMouseDown={(e) => { e.preventDefault(); removeExtra(value); }}
                                          className="ml-0.5 text-blue-500 hover:text-red-500"
                                        >×</button>
                                      </span>
                                    );
                                  }}
                                  options={[
                                    { value: "openai", label: t("typeOpenai") },
                                    { value: "anthropic", label: t("typeAnthropic") },
                                    { value: "azure", label: t("typeAzure") },
                                    { value: "custom", label: t("typeCustom") },
                                    { value: "gemini", label: t("typeGemini") },
                                  ].filter((o) => o.value !== primary)}
                                />
                              </Form.Item>
                            );
                          }}
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
                      <NamedKeyRow
                        key={index}
                        namedKey={namedKey}
                        index={index}
                        editing={!!editing}
                        canRemove={namedKeys.length > 1}
                        busy={togglingKeyIndex === index}
                        proxyOpen={expandedProxyIndex === index}
                        hasProxyChoices={availableProxyUrls.length > 0}
                        availableProxyUrls={availableProxyUrls}
                        onUpdateName={onUpdateKeyName}
                        onUpdateValue={onUpdateKeyValue}
                        onCopyKey={onCopyKey}
                        onToggleWhitelist={onToggleWhitelist}
                        onToggleKey={onToggleKey}
                        onRemove={handleRemoveKey}
                        onToggleProxyPanel={toggleProxyPanel}
                        onUpdateProxyUrls={onUpdateKeyProxyUrls}
                        onUpdateProxyStrict={onUpdateKeyProxyStrict}
                      />
                    ))}
                  </div>
                  <div className="border-t border-zinc-200/70 dark:border-zinc-700/50 pt-3 flex flex-col sm:flex-row gap-2">
                    <Button
                      variant="default"
                      onClick={onAddKey}
                      icon={<Plus size={14} />}
                      className="sm:flex-1 min-w-0"
                      size="sm"
                    >
                      {t("addKey")}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setBatchModalOpen(true)}
                      icon={<ClipboardPaste size={14} />}
                      className="sm:flex-1 min-w-0"
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
                    rules={[{ validator: validateForwardHeaders }]}
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
                  <Form.Item
                    name="whitelisted"
                    label={t("platformWhitelisted")}
                    valuePropName="checked"
                    extra={<span className={itemDesc}>{t("platformWhitelistedDesc")}</span>}
                    className="!mt-4 !mb-0"
                  >
                    <Switch />
                  </Form.Item>
                </>
              ),
            },
            {
              key: "advanced",
              label: <span className={groupTitle}>{t("groupAdvanced")}</span>,
              children: (
                <>
                  <Form.Item
                    name="reuseUserAgent"
                    label={t("reuseUserAgent")}
                    valuePropName="checked"
                    extra={<span className={itemDesc}>{t("reuseUserAgentDesc")}</span>}
                    className="!mb-4"
                  >
                    <Switch />
                  </Form.Item>
                  {formReuseUserAgent && (
                    <Form.Item
                      name="customUserAgent"
                      label={t("customUserAgent")}
                      extra={<span className={itemDesc}>{t("customUserAgentDesc")}</span>}
                      className="!mb-4"
                    >
                      <Input placeholder={t("customUserAgentPlaceholder")} />
                    </Form.Item>
                  )}
                  <Form.Item
                    name="extraHeaders"
                    label={t("extraHeaders")}
                    extra={<span className={itemDesc}>{t("extraHeadersDesc")}</span>}
                    className="!mb-0"
                    rules={[{ validator: validateExtraHeaders }]}
                  >
                    <Input.TextArea
                      rows={3}
                      placeholder={t("extraHeadersPlaceholder")}
                    />
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
        onOk={async () => {
          // 校验通过才关闭：name/baseUrl 必填，错误由 Modal 内 Form.Item 内联展示
          try {
            await form.validateFields(["name", "baseUrl"]);
            onInfoModalOpenChange(false);
          } catch {
            // 校验失败：保持弹窗打开
          }
        }}
        okText={t("common:save")}
        cancelText={t("common:cancel")}
        width="min(90vw, 640px)"
      >
        {/* 用 Form.Item 挂载三个字段：编辑模式下 basic 面板不渲染，
            若只 setFieldsValue 写 store，字段未注册 → validateFields() 返回值里
            没有 name/baseUrl/type → PUT 部分更新静默丢弃（rc-field-form 只返回
            已挂载字段的值）。Modal 在 <Form> 树内，portal 保留 context，
            Form.Item 可正常注册并参与提交校验 */}
        <div className="pt-2">
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
                { value: "anthropic", label: t("typeAnthropic") },
                { value: "azure", label: t("typeAzure") },
                { value: "custom", label: t("typeCustom") },
                { value: "gemini", label: t("typeGemini") },
              ]}
            />
          </Form.Item>
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
