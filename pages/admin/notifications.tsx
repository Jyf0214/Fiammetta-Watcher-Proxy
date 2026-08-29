/**
 * 通知中心 — 独立页面
 *
 * 解决原 settings.tsx 中通知 ProCard 的"最小实现"问题：
 * - 7 个 channel type 全暴露（telegram / bark / serverchan / lark / wecom / slack / generic / backup）
 * - 每条通道可独立 enable / 启停 / 测试发送
 * - options（Bark level/group/icon；Telegram chatId；Server酱 short/channel；Backup encryptionKey）
 * - headers 自定义（鉴权场景）
 * - 8 类事件订阅（含 platformRecovered / keyManuallyDisabled / backupFailed 三个此前 UI 缺失）
 * - 冷却 / 保留天数（含此前 dead code 的 backupRetentionDays）
 * - 测试发送（POST /api/admin/notifications/test）
 * - 发送历史（GET /api/admin/notifications/history，10 秒自动刷新）
 * - 通道健康度（GET /api/admin/notifications/stats，success/failed/avgDurationMs）
 *
 * 备份通道在此页面编辑后，备份中心页面复用 /api/admin/notifications PUT 写入同一份配置。
 * 不做"双配置"，避免数据漂移（与双端共有逻辑原则一致：单源配置，多页面展示）。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { message, Modal, Select, Tooltip, Switch as AntdSwitch } from "antd";
import {
  Bell,
  ChevronLeft,
  Database,
  History,
  Loader2,
  Plus,
  Save,
  Send,
  Trash2,
  Wand2,
  Activity,
  HelpCircle,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import Switch from "@/components/ui/Switch";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import AdminLayout from "@/components/AdminLayout";
import { formatDateTime } from "@/lib/timezone";
import { CHANNEL_TYPE_LABELS } from "@/lib/notification-types";
import type { ChannelType, NotificationEvent } from "@/lib/notification-types";

// ---------- 类型 ----------

type ChannelTypeLocal = ChannelType;
type NotificationEventLocal = NotificationEvent;

interface ChannelForm {
  id: string;
  name: string;
  type: ChannelTypeLocal;
  url: string;
  enabled: boolean;
  options: Array<{ key: string; value: string }>;
  headers: Array<{ key: string; value: string }>;
}

interface EventsForm {
  keyBanned: boolean;
  platformCircuitTripped: boolean;
  platformRecovered: boolean;
  platformDegraded: boolean;
  allUnavailable: boolean;
  quotaThreshold: boolean;
  keyManuallyDisabled: boolean;
  backupFailed: boolean;
}

interface NotifForm {
  enabled: boolean;
  channels: ChannelForm[];
  events: EventsForm;
  cooldownMinutes: number;
  backupRetentionDays: number;
}

interface HistoryItem {
  id: string;
  channelId: string;
  channelName: string;
  channelType: string;
  event: string;
  title: string;
  status: string;
  httpStatus: number | null;
  error: string | null;
  sizeBytes: number;
  durationMs: number;
  sentAt: number;
}

interface StatItem {
  channelId: string;
  channelName: string;
  channelType: string;
  total: number;
  success: number;
  failed: number;
  avgDurationMs: number;
  lastSentAt: number | null;
  lastStatus: string | null;
}

// ---------- 常量 ----------

// CHANNEL_TYPE_I18N 字典（属性名 = channel type 字面量；值 = i18n key），
// 目的是让 i18n-check 测试能扫到所有 type 键引用，避免动态模板拼接导致死键
// 误报（实际渲染走 t(CHANNEL_TYPE_I18N[type]) 静态查找）。
const CHANNEL_TYPE_I18N: Record<ChannelTypeLocal, string> = {
  telegram: "typeTelegram",
  bark: "typeBark",
  serverchan: "typeServerchan",
  lark: "typeLark",
  wecom: "typeWecom",
  slack: "typeSlack",
  generic: "typeGeneric",
  backup: "typeBackup",
};

const CHANNEL_TYPES: ChannelTypeLocal[] = [
  "telegram",
  "bark",
  "serverchan",
  "lark",
  "wecom",
  "slack",
  "generic",
  "backup",
];

const EVENTS: Array<{ key: keyof EventsForm; i18n: string; backend: NotificationEventLocal }> = [
  { key: "keyBanned", i18n: "eventKeyBanned", backend: "key_banned" },
  { key: "platformCircuitTripped", i18n: "eventPlatformOpen", backend: "platform_circuit_tripped" },
  { key: "platformRecovered", i18n: "eventPlatformRecovered", backend: "platform_recovered" },
  { key: "platformDegraded", i18n: "eventPlatformDegraded", backend: "platform_degraded" },
  { key: "allUnavailable", i18n: "eventAllUnavailable", backend: "all_unavailable" },
  { key: "quotaThreshold", i18n: "eventQuotaThreshold", backend: "quota_threshold" },
  { key: "keyManuallyDisabled", i18n: "eventKeyManuallyDisabled", backend: "key_manually_disabled" },
  { key: "backupFailed", i18n: "eventBackupFailed", backend: "backup_failed" },
];

const DEFAULT_FORM: NotifForm = {
  enabled: false,
  channels: [],
  events: {
    keyBanned: true,
    platformCircuitTripped: true,
    platformRecovered: true,
    platformDegraded: false,
    allUnavailable: true,
    quotaThreshold: true,
    keyManuallyDisabled: false,
    backupFailed: true,
  },
  cooldownMinutes: 10,
  backupRetentionDays: 30,
};

// ---------- 主页面 ----------

export default function NotificationsCenterPage() {
  const { t } = useTranslation("notif");

  const [form, setForm] = useState<NotifForm>(DEFAULT_FORM);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [expandedChannelId, setExpandedChannelId] = useState<string | null>(null);

  // 历史 + 统计
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyPage, setHistoryPage] = useState(1);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [stats, setStats] = useState<StatItem[]>([]);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsWindow, setStatsWindow] = useState(24);

  // 测试弹窗
  const [testTarget, setTestTarget] = useState<ChannelForm | null>(null);
  const [testEvent, setTestEvent] = useState<NotificationEventLocal>("key_banned");
  // 测试弹窗默认 title / body 在 openTest() 中通过 t() 初始化，避免硬编码中文
  const [testTitle, setTestTitle] = useState("");
  const [testBody, setTestBody] = useState("");
  const [testing, setTesting] = useState(false);

  // ---------- 加载配置 ----------

  const loadConfig = useCallback(async () => {
    setLoaded(false);
    try {
      const res = await fetch("/api/admin/notifications");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { success?: boolean; data?: Partial<NotifForm> };
      if (json?.success && json.data) {
        const channels: ChannelForm[] = (json.data.channels ?? []).map((c, i) => ({
          id: (c as ChannelForm).id || `ch-${Date.now()}-${i}`,
          name: c.name ?? "",
          type: (c.type ?? "generic") as ChannelTypeLocal,
          url: c.url ?? "",
          enabled: c.enabled !== false,
          options: Object.entries((c as ChannelForm).options ?? {}).map(([key, value]) => ({ key, value: String(value) })),
          headers: Object.entries((c as ChannelForm).headers ?? {}).map(([key, value]) => ({ key, value: String(value) })),
        }));
        setForm({
          ...DEFAULT_FORM,
          ...json.data,
          events: { ...DEFAULT_FORM.events, ...(json.data.events ?? {}) },
          channels,
          backupRetentionDays: json.data.backupRetentionDays ?? DEFAULT_FORM.backupRetentionDays,
        });
      }
    } catch (err) {
      message.error(t("commonError", { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setLoaded(true);
    }
  }, [t]);

  // ---------- 加载历史 ----------

  const loadHistory = useCallback(async (page: number) => {
    setHistoryLoading(true);
    try {
      const res = await fetch(`/api/admin/notifications/history?limit=20`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { success?: boolean; data?: HistoryItem[] };
      setHistory(json?.data ?? []);
      setHistoryPage(page);
    } catch (err) {
      message.error(t("commonError", { error: err instanceof Error ? err.message : String(err) }));
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [t]);

  // ---------- 加载统计 ----------

  const loadStats = useCallback(async (windowH: number) => {
    setStatsLoading(true);
    try {
      const res = await fetch(`/api/admin/notifications/stats?hours=${windowH}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { success?: boolean; data?: { byChannel: StatItem[] } };
      setStats(json?.data?.byChannel ?? []);
    } catch (err) {
      message.error(t("commonError", { error: err instanceof Error ? err.message : String(err) }));
      setStats([]);
    } finally {
      setStatsLoading(false);
    }
  }, [t]);

  // ---------- 副作用 ----------

  useEffect(() => {
    const t1 = setTimeout(loadConfig, 0);
    const t2 = setTimeout(() => loadHistory(1), 0);
    const t3 = setTimeout(() => loadStats(24), 0);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [loadConfig, loadHistory, loadStats]);

  // 自动刷新历史 + 统计
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      void loadHistory(historyPage);
      void loadStats(statsWindow);
    }, 10_000);
    return () => clearInterval(id);
  }, [autoRefresh, historyPage, loadHistory, loadStats, statsWindow]);

  // ---------- 通道操作 ----------

  const addChannel = () => {
    setForm((prev) => ({
      ...prev,
      channels: [
        ...prev.channels,
        {
          id: `ch-${crypto.randomUUID()}`,
          name: "",
          type: "generic",
          url: "",
          enabled: true,
          options: [],
          headers: [],
        },
      ],
    }));
  };

  const updateChannel = (id: string, patch: Partial<ChannelForm>) => {
    setForm((prev) => ({
      ...prev,
      channels: prev.channels.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }));
  };

  const removeChannel = (id: string) => {
    setForm((prev) => ({ ...prev, channels: prev.channels.filter((c) => c.id !== id) }));
    if (expandedChannelId === id) setExpandedChannelId(null);
  };

  const addOption = (channelId: string) => {
    setForm((prev) => ({
      ...prev,
      channels: prev.channels.map((c) =>
        c.id === channelId
          ? { ...c, options: [...c.options, { key: "", value: "" }] }
          : c
      ),
    }));
  };

  const updateOption = (channelId: string, idx: number, patch: Partial<{ key: string; value: string }>) => {
    setForm((prev) => ({
      ...prev,
      channels: prev.channels.map((c) =>
        c.id === channelId
          ? { ...c, options: c.options.map((o, i) => (i === idx ? { ...o, ...patch } : o)) }
          : c
      ),
    }));
  };

  const removeOption = (channelId: string, idx: number) => {
    setForm((prev) => ({
      ...prev,
      channels: prev.channels.map((c) =>
        c.id === channelId ? { ...c, options: c.options.filter((_, i) => i !== idx) } : c
      ),
    }));
  };

  const addHeader = (channelId: string) => {
    setForm((prev) => ({
      ...prev,
      channels: prev.channels.map((c) =>
        c.id === channelId
          ? { ...c, headers: [...c.headers, { key: "", value: "" }] }
          : c
      ),
    }));
  };

  const updateHeader = (channelId: string, idx: number, patch: Partial<{ key: string; value: string }>) => {
    setForm((prev) => ({
      ...prev,
      channels: prev.channels.map((c) =>
        c.id === channelId
          ? { ...c, headers: c.headers.map((h, i) => (i === idx ? { ...h, ...patch } : h)) }
          : c
      ),
    }));
  };

  const removeHeader = (channelId: string, idx: number) => {
    setForm((prev) => ({
      ...prev,
      channels: prev.channels.map((c) =>
        c.id === channelId ? { ...c, headers: c.headers.filter((_, i) => i !== idx) } : c
      ),
    }));
  };

  // ---------- 序列化 + 保存 ----------

  const serializeChannels = () =>
    form.channels.map((c) => {
      const options: Record<string, string> = {};
      for (const o of c.options) {
        const k = o.key.trim();
        if (k) options[k] = o.value;
      }
      const headers: Record<string, string> = {};
      for (const h of c.headers) {
        const k = h.key.trim();
        if (k) headers[k] = h.value;
      }
      return {
        id: c.id,
        name: c.name.trim(),
        type: c.type,
        url: c.url.trim(),
        enabled: c.enabled,
        options,
        headers,
      };
    });

  const handleSave = async () => {
    // 前端预校验（与服务端 strict 同语义）
    if (form.enabled && form.channels.length === 0) {
      message.error(t("errorNoChannel"));
      return;
    }
    for (const c of form.channels) {
      if (c.enabled && !/^https?:\/\//i.test(c.url.trim())) {
        message.error(t("errorBadUrl", { name: c.name || c.type }));
        return;
      }
    }
    const cooldown = Number(form.cooldownMinutes);
    if (!Number.isFinite(cooldown) || cooldown < 1 || cooldown > 1440) {
      message.error(t("errorCooldown"));
      return;
    }
    const retention = Number(form.backupRetentionDays);
    if (!Number.isFinite(retention) || retention < 1 || retention > 365) {
      message.error(t("errorRetention"));
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/admin/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: {
            enabled: form.enabled,
            channels: serializeChannels(),
            events: form.events,
            cooldownMinutes: Math.floor(cooldown),
            backupRetentionDays: Math.floor(retention),
          },
        }),
      });
      const json = (await res.json().catch(() => null)) as
        | { success?: boolean; error?: { message?: string } }
        | null;
      if (!res.ok || !json?.success) throw new Error(json?.error?.message || `HTTP ${res.status}`);
      message.success(t("saved"));
      // 保存成功后刷新历史 / 统计（可能因启用变化导致新事件触发）
      void loadHistory(historyPage);
      void loadStats(statsWindow);
    } catch (err) {
      message.error(t("commonError", { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setSaving(false);
    }
  };

  // ---------- 测试发送 ----------

  const openTest = (channel: ChannelForm) => {
    if (channel.type === "backup") {
      message.info(t("backupChannelTestHint"));
      return;
    }
    setTestTarget(channel);
    setTestEvent("key_banned");
    setTestTitle(t("testDefaultTitle"));
    setTestBody(t("testDefaultBody"));
  };

  const handleTestSend = async () => {
    if (!testTarget) return;
    setTesting(true);
    try {
      const res = await fetch("/api/admin/notifications/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId: testTarget.id,
          event: testEvent,
          title: testTitle,
          body: testBody,
        }),
      });
      const json = (await res.json().catch(() => null)) as
        | { success?: boolean; data?: { status: number | null; durationMs: number; error?: string | null }; error?: { message?: string } }
        | null;
      if (!res.ok || !json?.success) {
        const errMsg = json?.error?.message || `HTTP ${res.status}`;
        message.error(t("testFailed", { error: errMsg }));
        return;
      }
      const d = json.data;
      if (d?.error) {
        message.warning(t("testFailed", { error: d.error }));
      } else {
        message.success(t("testSuccess", { status: d?.status ?? "?", durationMs: d?.durationMs ?? 0 }));
      }
      setTestTarget(null);
      void loadHistory(historyPage);
    } catch (err) {
      message.error(t("commonError", { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setTesting(false);
    }
  };

  // ---------- 派生数据 ----------

  const enabledCount = useMemo(() => form.channels.filter((c) => c.enabled).length, [form.channels]);
  const enabledEventsCount = useMemo(() => Object.values(form.events).filter(Boolean).length, [form.events]);

  // ---------- 渲染 ----------

  return (
    <AdminLayout>
      <PageContainer>
        <PageHeader
          icon={<Bell size={20} className="text-zinc-500 dark:text-zinc-400" />}
          title={t("title")}
          description={t("desc")}
          extra={
            <Link href="/admin/settings">
              <Button variant="ghost" size="sm" icon={<ChevronLeft className="w-4 h-4 mr-1" />}>
                {t("backToSettings")}
              </Button>
            </Link>
          }
        />

        <div className="space-y-4">
          {/* ========== 摘要 + 总开关 ========== */}
          <ProCard>
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <Switch
                    checked={form.enabled}
                    onChange={(v: boolean) => setForm((prev) => ({ ...prev, enabled: v }))}
                    disabled={!loaded}
                  />
                  <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    {form.enabled ? t("enabled") : t("disabled")}
                  </span>
                </div>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  · {t("channelCount", { count: form.channels.length })}
                  {enabledCount !== form.channels.length && (
                    <span className="ml-1 text-amber-600 dark:text-amber-400">
                      {t("enabledSuffix", { count: enabledCount })}
                    </span>
                  )}
                </span>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  · {t("eventCount", { count: enabledEventsCount })}
                </span>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  · {t("cooldown", { minutes: form.cooldownMinutes })}
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">{t("tableChannel")}</p>
                  <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
                    {form.channels.length}
                  </p>
                </div>
                <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">{t("tableEventType")}</p>
                  <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
                    {enabledEventsCount}/{EVENTS.length}
                  </p>
                </div>
                <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">{t("tableRetention")}</p>
                  <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
                    {form.backupRetentionDays} <span className="text-sm font-normal text-zinc-500">{t("retentionUnit")}</span>
                  </p>
                </div>
              </div>
            </div>
          </ProCard>

          {/* ========== 事件订阅 ========== */}
          <ProCard title={t("eventCount", { count: EVENTS.length })}>
            <div className="space-y-3">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {t("eventsHint")}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {EVENTS.map((ev) => (
                  <label
                    key={ev.key}
                    className="flex items-center gap-2 px-3 py-2 rounded-md border border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700 cursor-pointer text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={form.events[ev.key]}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          events: { ...prev.events, [ev.key]: e.target.checked },
                        }))
                      }
                      className="w-4 h-4 accent-zinc-700 dark:accent-zinc-300"
                    />
                    <span className="flex-1 text-zinc-700 dark:text-zinc-300">{t(ev.i18n)}</span>
                    <code className="text-[10px] text-zinc-400 dark:text-zinc-500">
                      {ev.backend}
                    </code>
                  </label>
                ))}
              </div>
            </div>
          </ProCard>

          {/* ========== 通道列表 ========== */}
          <ProCard
            title={t("channelCount", { count: form.channels.length })}
            extra={
              <Button variant="ghost" size="sm" onClick={addChannel} icon={<Plus className="w-4 h-4 mr-1" />}>
                {t("addChannel")}
              </Button>
            }
          >
            {form.channels.length === 0 ? (
              <p className="text-sm text-zinc-400 py-4 text-center">{t("noChannels")}</p>
            ) : (
              <div className="space-y-3">
                {form.channels.map((c) => {
                  const isExpanded = expandedChannelId === c.id;
                  return (
                    <div
                      key={c.id}
                      className="rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden"
                    >
                      {/* 第一行：name / type / url / 启停 / 操作 */}
                      <div className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
                        <input
                          value={c.name}
                          onChange={(e) => updateChannel(c.id, { name: e.target.value })}
                          placeholder={t("channelName")}
                          className="h-8 w-full sm:w-36 shrink-0 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 text-sm"
                        />
                        <Select
                          value={c.type}
                          onChange={(v) => updateChannel(c.id, { type: v as ChannelTypeLocal })}
                          options={CHANNEL_TYPES.map((tp) => ({
                            value: tp,
                            label: t(CHANNEL_TYPE_I18N[tp]),
                          }))}
                          style={{ width: 180 }}
                          size="small"
                        />
                        <input
                          value={c.url}
                          onChange={(e) => updateChannel(c.id, { url: e.target.value })}
                          placeholder={c.type === "backup" ? "https://your-receiver.example.com/hook" : "https://..."}
                          className="h-8 w-full min-w-0 flex-1 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 text-sm"
                        />
                        <div className="flex items-center gap-1 shrink-0">
                          <span className="text-xs text-zinc-500 dark:text-zinc-400">
                            {c.enabled ? t("channelEnabled") : t("disabled")}
                          </span>
                          <Switch
                            checked={c.enabled}
                            onChange={(v: boolean) => updateChannel(c.id, { enabled: v })}
                          />
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Tooltip title={c.type === "backup" ? t("backupChannelTestHint") : t("channelTest")}>
                            <Button
                              variant="ghost"
                              size="sm"
                              iconOnly
                              onClick={() => openTest(c)}
                              disabled={c.type === "backup" || !c.url}
                            >
                              <Send className="w-3.5 h-3.5" />
                            </Button>
                          </Tooltip>
                          <Tooltip title={t(CHANNEL_TYPE_I18N[c.type])}>
                            <Button
                              variant="ghost"
                              size="sm"
                              iconOnly
                              onClick={() => setExpandedChannelId(isExpanded ? null : c.id)}
                            >
                              <Wand2 className="w-3.5 h-3.5" />
                            </Button>
                          </Tooltip>
                          <Button
                            variant="ghost"
                            size="sm"
                            iconOnly
                            onClick={() => removeChannel(c.id)}
                            title={t("common:delete")}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </div>

                      {/* 展开区：options + headers */}
                      {isExpanded && (
                        <div className="px-3 pb-3 pt-1 border-t border-zinc-100 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-950/30 space-y-3">
                          {/* Options */}
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                                {t("channelOptions")}
                              </p>
                              <Button variant="ghost" size="sm" onClick={() => addOption(c.id)} icon={<Plus className="w-3 h-3 mr-1" />}>
                                {t("addOption")}
                              </Button>
                            </div>
                            <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mb-2">
                              {t("channelOptionsHint")}
                            </p>
                            {c.options.length === 0 ? (
                              <p className="text-xs text-zinc-400 italic">{t("noOptions")}</p>
                            ) : (
                              <div className="space-y-1.5">
                                {c.options.map((o, i) => (
                                  <div key={i} className="flex gap-1.5">
                                    <input
                                      value={o.key}
                                      onChange={(e) => updateOption(c.id, i, { key: e.target.value })}
                                      placeholder={t("optionKey")}
                                      className="h-7 w-32 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 text-xs"
                                    />
                                    <input
                                      value={o.value}
                                      onChange={(e) => updateOption(c.id, i, { value: e.target.value })}
                                      placeholder={t("optionValue")}
                                      className="h-7 flex-1 min-w-0 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 text-xs"
                                    />
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      iconOnly
                                      onClick={() => removeOption(c.id, i)}
                                    >
                                      <Trash2 className="w-3 h-3" />
                                    </Button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>

                          {/* Headers */}
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                                {t("channelHeaders")}
                              </p>
                              <Button variant="ghost" size="sm" onClick={() => addHeader(c.id)} icon={<Plus className="w-3 h-3 mr-1" />}>
                                {t("addHeader")}
                              </Button>
                            </div>
                            <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mb-2">
                              {t("channelHeadersHint")}
                            </p>
                            {c.headers.length === 0 ? (
                              <p className="text-xs text-zinc-400 italic">{t("noHeaders")}</p>
                            ) : (
                              <div className="space-y-1.5">
                                {c.headers.map((h, i) => (
                                  <div key={i} className="flex gap-1.5">
                                    <input
                                      value={h.key}
                                      onChange={(e) => updateHeader(c.id, i, { key: e.target.value })}
                                      placeholder={t("optionKey")}
                                      className="h-7 w-32 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 text-xs"
                                    />
                                    <input
                                      value={h.value}
                                      onChange={(e) => updateHeader(c.id, i, { value: e.target.value })}
                                      placeholder={t("optionValue")}
                                      className="h-7 flex-1 min-w-0 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 text-xs"
                                    />
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      iconOnly
                                      onClick={() => removeHeader(c.id, i)}
                                    >
                                      <Trash2 className="w-3 h-3" />
                                    </Button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </ProCard>

          {/* ========== 冷却 + 保留 ========== */}
          <ProCard title={t("cooldownRetention")}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm text-zinc-700 dark:text-zinc-300">
                  {t("cooldownLabel")} ({t("cooldownUnit")})
                </label>
                <input
                  value={String(form.cooldownMinutes)}
                  onChange={(e) => setForm((prev) => ({ ...prev, cooldownMinutes: Number(e.target.value) || 0 }))}
                  inputMode="numeric"
                  className="h-8 w-full sm:w-32 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 text-sm"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm text-zinc-700 dark:text-zinc-300">
                  {t("retentionLabel")} ({t("retentionUnit")})
                </label>
                <input
                  value={String(form.backupRetentionDays)}
                  onChange={(e) => setForm((prev) => ({ ...prev, backupRetentionDays: Number(e.target.value) || 0 }))}
                  inputMode="numeric"
                  className="h-8 w-full sm:w-32 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 text-sm"
                />
              </div>
            </div>
          </ProCard>

          {/* ========== 通道健康度 ========== */}
          <ProCard
            title={
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-zinc-500" />
                <span>{t("stats")}</span>
              </div>
            }
            extra={
              <div className="flex items-center gap-2">
                <Select
                  value={statsWindow}
                  onChange={(v) => {
                    setStatsWindow(v);
                    void loadStats(v);
                  }}
                  options={[
                    { value: 1, label: `1 ${t("statsWindow")}` },
                    { value: 6, label: `6 ${t("statsWindow")}` },
                    { value: 24, label: `24 ${t("statsWindow")}` },
                    { value: 168, label: `7d` },
                    { value: 720, label: `30d` },
                  ]}
                  size="small"
                  style={{ width: 130 }}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => loadStats(statsWindow)}
                  loading={statsLoading}
                  icon={<Loader2 className="w-3.5 h-3.5" />}
                >
                  {t("historyRefresh")}
                </Button>
              </div>
            }
          >
            {statsLoading ? (
              <div className="flex items-center justify-center py-6 text-zinc-400">
                <Loader2 className="w-4 h-4 animate-spin" />
              </div>
            ) : stats.length === 0 ? (
              <p className="text-sm text-zinc-400 py-4 text-center">{t("noData")}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-800">
                    <tr>
                      <th className="text-left py-2 px-2">{t("tableChannel")}</th>
                      <th className="text-left py-2 px-2">{t("tableType")}</th>
                      <th className="text-right py-2 px-2">{t("statsTotal")}</th>
                      <th className="text-right py-2 px-2">{t("statsSuccess")}</th>
                      <th className="text-right py-2 px-2">{t("statsFailed")}</th>
                      <th className="text-right py-2 px-2">{t("statsAvgDuration")}</th>
                      <th className="text-left py-2 px-2">{t("statsLastSent")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.map((s) => (
                      <tr key={s.channelId} className="border-b border-zinc-100 dark:border-zinc-800">
                        <td className="py-2 px-2 text-zinc-900 dark:text-zinc-100">{s.channelName}</td>
                        <td className="py-2 px-2 text-zinc-500 dark:text-zinc-400 text-xs">
                          {CHANNEL_TYPE_LABELS[s.channelType as keyof typeof CHANNEL_TYPE_LABELS] ?? s.channelType}
                        </td>
                        <td className="py-2 px-2 text-right">{s.total}</td>
                        <td className="py-2 px-2 text-right text-emerald-600 dark:text-emerald-400">{s.success}</td>
                        <td className="py-2 px-2 text-right text-red-600 dark:text-red-400">{s.failed}</td>
                        <td className="py-2 px-2 text-right text-zinc-600 dark:text-zinc-300">{s.avgDurationMs}ms</td>
                        <td className="py-2 px-2 text-zinc-500 dark:text-zinc-400 text-xs">
                          {s.lastSentAt ? formatDateTime(s.lastSentAt) : "—"}
                          {s.lastStatus && (
                            <span
                              className={`ml-1 ${
                                s.lastStatus === "success"
                                  ? "text-emerald-600 dark:text-emerald-400"
                                  : "text-red-600 dark:text-red-400"
                              }`}
                            >
                              ({s.lastStatus === "success" ? "✓" : "✗"})
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </ProCard>

          {/* ========== 发送历史 ========== */}
          <ProCard
            title={
              <div className="flex items-center gap-2">
                <History className="w-4 h-4 text-zinc-500" />
                <span>{t("history")}</span>
              </div>
            }
            extra={
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                  <AntdSwitch size="small" checked={autoRefresh} onChange={setAutoRefresh} />
                  {t("historyAutoRefresh")}
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => loadHistory(historyPage)}
                  loading={historyLoading}
                  icon={<Loader2 className="w-3.5 h-3.5" />}
                >
                  {t("historyRefresh")}
                </Button>
              </div>
            }
          >
            {historyLoading && history.length === 0 ? (
              <div className="flex items-center justify-center py-6 text-zinc-400">
                <Loader2 className="w-4 h-4 animate-spin" />
              </div>
            ) : history.length === 0 ? (
              <p className="text-sm text-zinc-400 py-4 text-center">{t("historyEmpty")}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-800">
                    <tr>
                      <th className="text-left py-2 px-2">{t("tableTime")}</th>
                      <th className="text-left py-2 px-2">{t("tableChannel")}</th>
                      <th className="text-left py-2 px-2">{t("tableEvent")}</th>
                      <th className="text-left py-2 px-2">{t("tableTitle")}</th>
                      <th className="text-center py-2 px-2">{t("tableStatus")}</th>
                      <th className="text-right py-2 px-2">HTTP</th>
                      <th className="text-right py-2 px-2">{t("columnDuration")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h) => (
                      <tr key={h.id} className="border-b border-zinc-100 dark:border-zinc-800">
                        <td className="py-2 px-2 text-xs text-zinc-500 dark:text-zinc-400">
                          {formatDateTime(h.sentAt)}
                        </td>
                        <td className="py-2 px-2 text-zinc-900 dark:text-zinc-100">{h.channelName}</td>
                        <td className="py-2 px-2 text-xs">
                          <code className="text-zinc-500 dark:text-zinc-400">{h.event}</code>
                        </td>
                        <td className="py-2 px-2 text-zinc-700 dark:text-zinc-300 max-w-[200px] truncate" title={h.title}>
                          {h.title}
                        </td>
                        <td className="py-2 px-2 text-center">
                          {h.status === "success" ? (
                            <span className="text-emerald-600 dark:text-emerald-400">✓</span>
                          ) : (
                            <span className="text-red-600 dark:text-red-400" title={h.error ?? ""}>
                              ✗
                            </span>
                          )}
                        </td>
                        <td className="py-2 px-2 text-right text-zinc-500 dark:text-zinc-400 text-xs">
                          {h.httpStatus ?? "—"}
                        </td>
                        <td className="py-2 px-2 text-right text-zinc-500 dark:text-zinc-400 text-xs">
                          {h.durationMs}ms
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </ProCard>

          {/* ========== 保存按钮 ========== */}
          <div className="flex justify-end gap-2 sticky bottom-2 bg-zinc-50/80 dark:bg-zinc-950/80 backdrop-blur p-3 rounded-lg border border-zinc-200 dark:border-zinc-800">
            <Link href="/admin/backup">
              <Button variant="secondary" size="sm" icon={<Database className="w-4 h-4 mr-1" />}>
                {t("backupPageLink")}
              </Button>
            </Link>
            <Button
              variant="primary"
              size="sm"
              onClick={handleSave}
              loading={saving}
              icon={<Save className="w-4 h-4 mr-1" />}
              disabled={saving || !loaded}
            >
              {saving ? t("saving") : t("save")}
            </Button>
          </div>
        </div>
      </PageContainer>

      {/* 测试发送弹窗 */}
      <Modal
        title={t("testModalTitle")}
        open={testTarget !== null}
        onCancel={() => setTestTarget(null)}
        onOk={handleTestSend}
        okText={t("testSendBtn")}
        cancelText={t("cancelText")}
        confirmLoading={testing}
        width={560}
        destroyOnClose
      >
        {testTarget && (
          <div className="space-y-3 py-2">
            <div>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">{t("tableChannel")}</p>
              <p className="text-sm">
                <span className="font-medium">{testTarget.name || testTarget.type}</span>{" "}
                <code className="text-xs text-zinc-500">({testTarget.type})</code>
              </p>
            </div>
            <div>
              <label className="text-xs text-zinc-500 dark:text-zinc-400 mb-1 block">
                {t("testEventLabel")}
              </label>
              <Select
                value={testEvent}
                onChange={(v) => setTestEvent(v as NotificationEventLocal)}
                options={EVENTS.map((ev) => ({ value: ev.backend, label: t(ev.i18n) }))}
                className="w-full"
                size="middle"
              />
            </div>
            <div>
              <label className="text-xs text-zinc-500 dark:text-zinc-400 mb-1 block">
                {t("testTitleLabel")}
              </label>
              <input
                value={testTitle}
                onChange={(e) => setTestTitle(e.target.value)}
                className="w-full h-8 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-zinc-500 dark:text-zinc-400 mb-1 block">
                {t("testBodyLabel")}
              </label>
              <textarea
                value={testBody}
                onChange={(e) => setTestBody(e.target.value)}
                rows={4}
                className="w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm"
              />
            </div>
            <div className="rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 p-2 text-xs text-amber-700 dark:text-amber-300 flex items-start gap-1.5">
              <HelpCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                {t("testNotice")}
              </span>
            </div>
          </div>
        )}
      </Modal>
    </AdminLayout>
  );
}
