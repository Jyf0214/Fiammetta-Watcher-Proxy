/**
 * 系统设置页
 *
 * 当前包含：
 * - 模型价格表：成本核算的价格来源（美元/百万 token）。上游 usage 自报成本时
 *   优先采信实时计价，本表仅作无自报时的估算回退。
 *
 * 后续批次将在此页扩展：告警通知配置、两步验证（2FA）等系统级设置。
 */

import { useCallback, useEffect, useState } from "react";
import { message } from "antd";
import {
  Bell,
  CircleDollarSign,
  Download,
  KeyRound,
  Loader2,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import AdminLayout from "@/components/AdminLayout";

interface PricingRow {
  id: string;
  model: string;
  input: string;
  output: string;
}

interface NotificationChannel {
  name: string;
  url: string;
}

interface NotificationsConfig {
  enabled: boolean;
  channels: NotificationChannel[];
  events: {
    keyBanned: boolean;
    platformOpen: boolean;
    platformDegraded: boolean;
    allUnavailable: boolean;
    quotaThreshold: boolean;
  };
  cooldownMinutes: number;
}

const DEFAULT_NOTIFICATIONS: NotificationsConfig = {
  enabled: false,
  channels: [],
  events: {
    keyBanned: true,
    platformOpen: true,
    platformDegraded: false,
    allUnavailable: true,
    quotaThreshold: true,
  },
  cooldownMinutes: 10,
};

function SettingsContent() {
  const { t } = useTranslation("settings");
  const [rows, setRows] = useState<PricingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);

  // 通知配置
  const [notif, setNotif] = useState<NotificationsConfig>(DEFAULT_NOTIFICATIONS);
  const [notifLoading, setNotifLoading] = useState(true);
  const [notifSaving, setNotifSaving] = useState(false);

  // 两步验证（2FA）
  const [twofaEnabled, setTwofaEnabled] = useState(false);
  const [twofaLoading, setTwofaLoading] = useState(true);
  const [twofaBusy, setTwofaBusy] = useState(false);
  const [pendingSecret, setPendingSecret] = useState<string | null>(null);
  const [pendingUri, setPendingUri] = useState<string>("");
  const [confirmCode, setConfirmCode] = useState("");
  const [disableCode, setDisableCode] = useState("");

  const loadPricing = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/admin/pricing");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        success?: boolean;
        data?: Record<string, { input: number; output: number }>;
        error?: { message?: string };
      };
      if (!json?.success) throw new Error(json?.error?.message || "load failed");
      const data = json.data ?? {};
      setRows(
        Object.entries(data).map(([model, p], i) => ({
          id: `row-${i}-${model}`,
          model,
          input: String(p.input),
          output: String(p.output),
        }))
      );
    } catch (err) {
      // 加载失败保留空列表但给出可重试错误，不清空用户可能未保存的编辑——
      // 首次加载失败与保存失败都走同一提示路径
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadNotifications = useCallback(async () => {
    setNotifLoading(true);
    try {
      const res = await fetch("/api/admin/notifications");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { success?: boolean; data?: Partial<NotificationsConfig> };
      if (json?.success && json.data) {
        setNotif({
          ...DEFAULT_NOTIFICATIONS,
          ...json.data,
          events: { ...DEFAULT_NOTIFICATIONS.events, ...(json.data.events ?? {}) },
        });
      }
    } catch (err) {
      message.error(`${t("common:error")}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setNotifLoading(false);
    }
  }, [t]);

  const handleSaveNotifications = async () => {
    // 前端预校验（与服务端 strict 校验同规则）：启用时至少一条通道
    if (notif.enabled && notif.channels.length === 0) {
      message.error(t("notifErrorNoChannel"));
      return;
    }
    for (const c of notif.channels) {
      if (!/^https?:\/\//i.test(c.url.trim())) {
        message.error(t("notifErrorBadUrl", { name: c.name }));
        return;
      }
    }
    const cooldown = Number(notif.cooldownMinutes);
    if (!Number.isFinite(cooldown) || cooldown < 1 || cooldown > 1440) {
      message.error(t("notifErrorCooldown"));
      return;
    }
    setNotifSaving(true);
    try {
      const res = await fetch("/api/admin/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: {
            ...notif,
            cooldownMinutes: Math.floor(cooldown),
            channels: notif.channels.map((c) => ({ name: c.name.trim(), url: c.url.trim() })),
          },
        }),
      });
      const json = (await res.json().catch(() => null)) as { success?: boolean; error?: { message?: string } } | null;
      if (!res.ok || !json?.success) throw new Error(json?.error?.message || `HTTP ${res.status}`);
      message.success(t("notifSaved"));
    } catch (err) {
      message.error(`${t("common:error")}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setNotifSaving(false);
    }
  };

  const updateChannel = (idx: number, patch: Partial<NotificationChannel>) => {
    setNotif((prev) => ({
      ...prev,
      channels: prev.channels.map((c, i) => (i === idx ? { ...c, ...patch } : c)),
    }));
  };

  // ==================== 两步验证（2FA） ====================

  const load2fa = useCallback(async () => {
    setTwofaLoading(true);
    try {
      const res = await fetch("/api/admin/2fa");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { success?: boolean; data?: { enabled?: boolean } };
      setTwofaEnabled(json?.data?.enabled === true);
    } catch (err) {
      message.error(`${t("common:error")}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTwofaLoading(false);
    }
  }, [t]);

  const twofaPost = async (body: Record<string, unknown>) => {
    const res = await fetch("/api/admin/2fa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json().catch(() => null)) as {
      success?: boolean;
      data?: { secret?: string; otpauthUri?: string };
      error?: string | { message?: string };
    } | null;
  };

  const handleBegin2fa = async () => {
    setTwofaBusy(true);
    try {
      const json = await twofaPost({ action: "begin" });
      if (!json?.success || !json.data?.secret) throw new Error("begin failed");
      setPendingSecret(json.data.secret);
      setPendingUri(json.data.otpauthUri ?? "");
      setConfirmCode("");
    } catch (err) {
      message.error(`${t("common:error")}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTwofaBusy(false);
    }
  };

  const handleConfirm2fa = async () => {
    if (!pendingSecret || confirmCode.length !== 6) {
      message.error(t("twofaErrorNeedCode"));
      return;
    }
    setTwofaBusy(true);
    try {
      const json = await twofaPost({ action: "confirm", secret: pendingSecret, code: confirmCode });
      if (!json?.success) throw new Error(typeof json?.error === "string" ? json.error : "confirm failed");
      message.success(t("twofaEnabled"));
      // 成功后立即清空注册材料（secret 不在页面残留）
      setPendingSecret(null);
      setPendingUri("");
      setConfirmCode("");
      await load2fa();
    } catch (err) {
      message.error(`${t("common:error")}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTwofaBusy(false);
    }
  };

  const handleDisable2fa = async () => {
    if (disableCode.length !== 6) {
      message.error(t("twofaErrorNeedCode"));
      return;
    }
    setTwofaBusy(true);
    try {
      const json = await twofaPost({ action: "disable", code: disableCode });
      if (!json?.success) throw new Error(typeof json?.error === "string" ? json.error : "disable failed");
      message.success(t("twofaDisabled"));
      setDisableCode("");
      await load2fa();
    } catch (err) {
      message.error(`${t("common:error")}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTwofaBusy(false);
    }
  };

  useEffect(() => {
    // 延迟到宏任务执行：loadPricing 首行同步 setLoading 会触发
    // react-hooks/set-state-in-effect（effect 体内禁止同步 setState）
    const timer = setTimeout(loadPricing, 0);
    const notifTimer = setTimeout(loadNotifications, 0);
    const twofaTimer = setTimeout(load2fa, 0);
    return () => {
      clearTimeout(timer);
      clearTimeout(notifTimer);
      clearTimeout(twofaTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateRow = (id: string, patch: Partial<PricingRow>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const removeRow = (id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
  };

  const addRow = () => {
    setRows((prev) => [
      ...prev,
      { id: `row-new-${Date.now()}`, model: "", input: "", output: "" },
    ]);
  };

  /** 校验并序列化：非法输入直接报错且不提交，保留现场供修正 */
  const buildPayload = (): Record<string, { input: number; output: number }> | null => {
    const payload: Record<string, { input: number; output: number }> = {};
    for (const r of rows) {
      const name = r.model.trim();
      const input = Number(r.input);
      const output = Number(r.output);
      if (!name) {
        message.error(t("pricingErrorEmptyModel"));
        return null;
      }
      if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) {
        message.error(t("pricingErrorInvalidPrice", { model: name }));
        return null;
      }
      if (payload[name]) {
        message.error(t("pricingErrorDuplicate", { model: name }));
        return null;
      }
      payload[name] = { input, output };
    }
    return payload;
  }

  const handleSave = async () => {
    const pricing = buildPayload();
    if (pricing === null) return;
    setSaving(true);
    try {
      const res = await fetch("/api/admin/pricing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pricing }),
      });
      const json = (await res.json().catch(() => null)) as {
        success?: boolean;
        error?: { message?: string };
      } | null;
      if (!res.ok || !json?.success) {
        throw new Error(json?.error?.message || `HTTP ${res.status}`);
      }
      message.success(t("pricingSaved"));
    } catch (err) {
      message.error(`${t("common:error")}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleImport = async () => {
    setImporting(true);
    try {
      const res = await fetch("/api/admin/pricing/import", { method: "POST" });
      const json = (await res.json().catch(() => null)) as {
        success?: boolean;
        data?: { imported?: number; total?: number };
        error?: { message?: string };
      } | null;
      if (!res.ok || !json?.success) {
        throw new Error(json?.error?.message || `HTTP ${res.status}`);
      }
      message.success(
        t("pricingImportSuccess", {
          imported: json.data?.imported ?? 0,
          total: json.data?.total ?? 0,
        })
      );
      await loadPricing();
    } catch (err) {
      message.error(`${t("common:error")}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <AdminLayout>
      <PageContainer>
        <PageHeader
          icon={<CircleDollarSign size={20} className="text-zinc-500 dark:text-zinc-400" />}
          title={t("title")}
          description={t("desc")}
        />

        {/* 卡片间距容器：ProCard 无外边距，多卡片平铺需显式 gap（对齐 data-manager 惯例） */}
        <div className="space-y-4">
        <ProCard title={t("pricingTitle")}>
          <div className="space-y-4">
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {t("pricingUnitHint")}
            </p>
            <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
              {t("common:costDisclaimer")}
            </p>

            {/* 表头 */}
            <div className="hidden sm:grid grid-cols-[1fr_140px_140px_40px] gap-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
              <span>{t("pricingModel")}</span>
              <span className="text-right">{t("pricingInputPrice")}</span>
              <span className="text-right">{t("pricingOutputPrice")}</span>
              <span />
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-8 text-zinc-400">
                <Loader2 className="w-5 h-5 animate-spin" />
              </div>
            ) : loadError ? (
              <div className="space-y-2">
                <p className="text-sm text-red-500 break-all">{`${t("common:error")}: ${loadError}`}</p>
                <Button variant="secondary" size="sm" onClick={loadPricing}>
                  {t("common:retry")}
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                {rows.map((row) => (
                  <div
                    key={row.id}
                    className="grid grid-cols-[1fr_100px_100px_32px] sm:grid-cols-[1fr_140px_140px_40px] gap-2 items-center"
                  >
                    <input
                      value={row.model}
                      onChange={(e) => updateRow(row.id, { model: e.target.value })}
                      placeholder={t("pricingModelPlaceholder")}
                      className="h-8 w-full min-w-0 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-500"
                    />
                    <input
                      value={row.input}
                      onChange={(e) => updateRow(row.id, { input: e.target.value })}
                      inputMode="decimal"
                      placeholder="0.00"
                      className="h-8 w-full min-w-0 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 text-sm text-right text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-500"
                    />
                    <input
                      value={row.output}
                      onChange={(e) => updateRow(row.id, { output: e.target.value })}
                      inputMode="decimal"
                      placeholder="0.00"
                      className="h-8 w-full min-w-0 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 text-sm text-right text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-500"
                    />
                    <button
                      type="button"
                      onClick={() => removeRow(row.id)}
                      title={t("common:delete")}
                      className="h-8 w-8 flex items-center justify-center rounded-md text-zinc-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
                {rows.length === 0 && (
                  <p className="text-sm text-zinc-400 py-4 text-center">
                    {t("pricingEmpty")}
                  </p>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-zinc-100 dark:border-zinc-800">
              <Button variant="ghost" size="sm" onClick={addRow} disabled={loading}>
                <Plus className="w-4 h-4 mr-1" />
                {t("pricingAddModel")}
              </Button>
              <div className="flex-1" />
              <Button variant="secondary" size="sm" onClick={handleImport} loading={importing} icon={<Download className="w-4 h-4 mr-1" />} disabled={importing || saving || loading}>
                {importing ? t("pricingImporting") : t("pricingImportLiteLLM")}
              </Button>
              <Button variant="primary" size="sm" onClick={handleSave} loading={saving} icon={<Save className="w-4 h-4 mr-1" />} disabled={saving || importing || loading}>
                {saving ? t("pricingSaving") : t("common:save")}
              </Button>
            </div>
          </div>
        </ProCard>

        {/* ========== 告警通知配置 ========== */}
        <ProCard title={t("notifTitle")}>
          <div className="space-y-4">
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{t("notifDesc")}</p>

            {notifLoading ? (
              <div className="flex items-center justify-center py-8 text-zinc-400">
                <Loader2 className="w-5 h-5 animate-spin" />
              </div>
            ) : (
              <>
                {/* 启用开关 */}
                <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={notif.enabled}
                    onChange={(e) => setNotif((prev) => ({ ...prev, enabled: e.target.checked }))}
                    className="w-4 h-4 accent-zinc-700 dark:accent-zinc-300"
                  />
                  {t("notifEnabled")}
                </label>

                {/* 事件开关 */}
                <div>
                  <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-2">{t("notifEvents")}</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {([
                      ["keyBanned", "notifEventKeyBanned"],
                      ["platformOpen", "notifEventPlatformOpen"],
                      ["platformDegraded", "notifEventPlatformDegraded"],
                      ["allUnavailable", "notifEventAllUnavailable"],
                      ["quotaThreshold", "notifEventQuotaThreshold"],
                    ] as const).map(([key, label]) => (
                      <label key={key} className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={notif.events[key]}
                          onChange={(e) => setNotif((prev) => ({ ...prev, events: { ...prev.events, [key]: e.target.checked } }))}
                          className="w-4 h-4 accent-zinc-700 dark:accent-zinc-300"
                        />
                        {t(label)}
                      </label>
                    ))}
                  </div>
                </div>

                {/* 通道列表 */}
                <div>
                  <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-2">{t("notifChannels")}</p>
                  <div className="space-y-2">
                    {notif.channels.map((c, idx) => (
                      <div key={idx} className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
                        <input
                          value={c.name}
                          onChange={(e) => updateChannel(idx, { name: e.target.value })}
                          placeholder={t("notifChannelName")}
                          className="h-8 w-full sm:w-36 shrink-0 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-500"
                        />
                        <input
                          value={c.url}
                          onChange={(e) => updateChannel(idx, { url: e.target.value })}
                          placeholder="https://..."
                          className="h-8 w-full min-w-0 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-500"
                        />
                        <button
                          type="button"
                          onClick={() => setNotif((prev) => ({ ...prev, channels: prev.channels.filter((_, i) => i !== idx) }))}
                          title={t("common:delete")}
                          className="h-8 w-8 shrink-0 flex items-center justify-center rounded-md text-zinc-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                    {notif.channels.length === 0 && (
                      <p className="text-sm text-zinc-400 py-1">{t("notifNoChannels")}</p>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => setNotif((prev) => ({ ...prev, channels: [...prev.channels, { name: "", url: "" }] }))}>
                      <Plus className="w-4 h-4 mr-1" />
                      {t("notifAddChannel")}
                    </Button>
                  </div>
                </div>

                {/* 冷却时间 */}
                <div className="flex items-center gap-2">
                  <label className="text-sm text-zinc-700 dark:text-zinc-300">{t("notifCooldown")}</label>
                  <input
                    value={String(notif.cooldownMinutes)}
                    onChange={(e) => setNotif((prev) => ({ ...prev, cooldownMinutes: Number(e.target.value) || 0 }))}
                    inputMode="numeric"
                    className="h-8 w-20 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 text-sm text-right text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-500"
                  />
                  <span className="text-sm text-zinc-500 dark:text-zinc-400">{t("notifCooldownUnit")}</span>
                </div>

                <div className="flex justify-end pt-2 border-t border-zinc-100 dark:border-zinc-800">
                  <Button variant="primary" size="sm" onClick={handleSaveNotifications} loading={notifSaving} icon={<Bell className="w-4 h-4 mr-1" />} disabled={notifSaving || notifLoading}>
                    {notifSaving ? t("notifSaving") : t("common:save")}
                  </Button>
                </div>
              </>
            )}
          </div>
        </ProCard>

        {/* ========== 两步验证（2FA） ========== */}
        <ProCard title={t("twofaTitle")}>
          <div className="space-y-4">
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{t("twofaDesc")}</p>

            {twofaLoading ? (
              <div className="flex items-center justify-center py-8 text-zinc-400">
                <Loader2 className="w-5 h-5 animate-spin" />
              </div>
            ) : twofaEnabled && !pendingSecret ? (
              /* 已启用：展示状态 + 关闭入口（需当前验证码） */
              <div className="space-y-3">
                <p className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
                  <ShieldCheck className="w-4 h-4" />
                  {t("twofaActive")}
                </p>
                <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
                  <input
                    value={disableCode}
                    onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, ""))}
                    inputMode="numeric"
                    maxLength={6}
                    placeholder={t("twofaCodePlaceholder")}
                    className="h-8 w-full sm:w-40 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 text-sm tracking-[0.4em] text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-500"
                  />
                  <Button variant="dangerGhost" size="sm" onClick={handleDisable2fa} loading={twofaBusy} icon={<KeyRound className="w-4 h-4 mr-1" />} disabled={twofaBusy}>
                    {t("twofaDisable")}
                  </Button>
                </div>
              </div>
            ) : pendingSecret ? (
              /* 注册中：展示密钥/URI → 输码确认 */
              <div className="space-y-3">
                <p className="text-sm text-zinc-700 dark:text-zinc-300">{t("twofaAddHint")}</p>
                <div className="rounded-lg bg-zinc-50 dark:bg-zinc-900 p-3 space-y-2 overflow-x-auto">
                  <code className="block text-xs break-all text-zinc-700 dark:text-zinc-300">{pendingUri}</code>
                  <code className="block text-sm font-mono font-semibold tracking-wider text-zinc-900 dark:text-zinc-100 select-all">{pendingSecret}</code>
                </div>
                <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
                  <input
                    value={confirmCode}
                    onChange={(e) => setConfirmCode(e.target.value.replace(/\D/g, ""))}
                    inputMode="numeric"
                    maxLength={6}
                    placeholder={t("twofaCodePlaceholder")}
                    className="h-8 w-full sm:w-40 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 text-sm tracking-[0.4em] text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-500"
                  />
                  <Button variant="primary" size="sm" onClick={handleConfirm2fa} loading={twofaBusy} icon={<ShieldCheck className="w-4 h-4 mr-1" />} disabled={twofaBusy}>
                    {t("twofaConfirm")}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => { setPendingSecret(null); setPendingUri(""); }} disabled={twofaBusy}>
                    {t("common:cancel")}
                  </Button>
                </div>
              </div>
            ) : (
              /* 未启用：开启按钮 */
              <div>
                <Button variant="primary" size="sm" onClick={handleBegin2fa} loading={twofaBusy} icon={<KeyRound className="w-4 h-4 mr-1" />} disabled={twofaBusy}>
                  {t("twofaEnable")}
                </Button>
              </div>
            )}
          </div>
        </ProCard>
        </div>
      </PageContainer>
    </AdminLayout>
  );
}

export default function AdminSettings() {
  return <SettingsContent />;
}
