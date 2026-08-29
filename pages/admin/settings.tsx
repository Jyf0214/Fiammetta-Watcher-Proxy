/**
 * 系统设置页
 *
 * 当前包含：
 * - 模型价格表：成本核算的价格来源（美元/百万 token）。上游 usage 自报成本时
 *   优先采信实时计价，本表仅作无自报时的估算回退。
 *
 * 后续批次将在此页扩展：告警通知配置、两步验证（2FA）等系统级设置。
 */

import { useCallback, useEffect, useRef, useState, memo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import Link from "next/link";
import { message } from "antd";
import {
  Bell,
  CircleDollarSign,
  Code2,
  Database,
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

/** 单行价格配置 — memo 化：更新回调为稳定引用，输入击键只重渲染当前行
 *  （LiteLLM 导入后可达数千行，行内联渲染时每次击键全表重渲染导致卡顿）
 *  移动端采用垂直堆叠卡片（模型名 / 输入 / 输出 / 删除分四行 + 列头小字），
 *  避免桌面端 4 列 grid 在窄屏把 1fr 列挤成空 pill、价格列溢出右侧；桌面 sm+
 *  仍走 4 列 grid 保证信息密度。 */
const PricingRowItem = memo(function PricingRowItem({
  row,
  onUpdate,
  onRemove,
}: {
  row: PricingRow;
  onUpdate: (id: string, patch: Partial<PricingRow>) => void;
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <>
      {/* 移动端：垂直堆叠卡片 */}
      <div className="sm:hidden space-y-2 rounded-md border border-zinc-100 dark:border-zinc-800 p-2">
        <div>
          <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
            {t("pricingModel")}
          </span>
          <input
            value={row.model}
            onChange={(e) => onUpdate(row.id, { model: e.target.value })}
            placeholder={t("pricingModelPlaceholder")}
            className="mt-1 h-8 w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-500"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
              {t("pricingInputPrice")}
            </span>
            <input
              value={row.input}
              onChange={(e) => onUpdate(row.id, { input: e.target.value })}
              inputMode="decimal"
              placeholder="0.00"
              className="mt-1 h-8 w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 text-sm text-right text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-500"
            />
          </div>
          <div>
            <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
              {t("pricingOutputPrice")}
            </span>
            <input
              value={row.output}
              onChange={(e) => onUpdate(row.id, { output: e.target.value })}
              inputMode="decimal"
              placeholder="0.00"
              className="mt-1 h-8 w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 text-sm text-right text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-500"
            />
          </div>
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => onRemove(row.id)}
            title={t("common:delete")}
            className="h-8 px-2 flex items-center gap-1 rounded-md text-zinc-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            <span className="text-xs">{t("common:delete")}</span>
          </button>
        </div>
      </div>

      {/* 桌面端：原 4 列 grid */}
      <div className="hidden sm:grid grid-cols-[1fr_140px_140px_40px] gap-2 items-center">
        <input
          value={row.model}
          onChange={(e) => onUpdate(row.id, { model: e.target.value })}
          placeholder={t("pricingModelPlaceholder")}
          className="h-8 w-full min-w-0 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-500"
        />
        <input
          value={row.input}
          onChange={(e) => onUpdate(row.id, { input: e.target.value })}
          inputMode="decimal"
          placeholder="0.00"
          className="h-8 w-full min-w-0 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 text-sm text-right text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-500"
        />
        <input
          value={row.output}
          onChange={(e) => onUpdate(row.id, { output: e.target.value })}
          inputMode="decimal"
          placeholder="0.00"
          className="h-8 w-full min-w-0 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 text-sm text-right text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-500"
        />
        <button
          type="button"
          onClick={() => onRemove(row.id)}
          title={t("common:delete")}
          className="h-8 w-8 flex items-center justify-center rounded-md text-zinc-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </>
  );
});

function SettingsContent() {
  const { t } = useTranslation("settings");
  const [rows, setRows] = useState<PricingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  // 定价虚拟列表：rows 加载后可上千上万行，整表渲染会卡死浏览器，
  // 改为按可视窗口 + overscan 渲染。父容器 max-h 决定 scroll 范围。
  const pricingListRef = useRef<HTMLDivElement>(null);
  // useVirtualizer 返回的函数不能安全 memo，react-hooks plugin 会跳过
  // 本组件的 React Compiler memo 化；用 useCallback 包装消费侧避免误用即可。
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => pricingListRef.current,
    // 移动端行是垂直堆叠卡片（~120px），桌面端是 40px 行；估算取较大值避免
    // 移动端初次定位偏差（测量前 ResizeObserver 尚未触发）。默认 measureElement
    // 已用 getBoundingClientRect 读取实测高度，外部加 data-index + ref 即可，
    // 不需自写覆盖
    estimateSize: () => 120,
    overscan: 8,
  });

  // 通知配置 — 仅用于系统设置页"告警通知" ProCard 的摘要展示（启用状态 +
  // 通道数）。完整配置入口已迁移到独立 /admin/notifications 页面，避免
  // settings 页成为"通知功能的最小实现"（参见 [project memory] 形同虚设 bug）
  const [notif, setNotif] = useState<NotificationsConfig>(DEFAULT_NOTIFICATIONS);
  const [notifLoading, setNotifLoading] = useState(true);

  // 两步验证（2FA）
  const [twofaEnabled, setTwofaEnabled] = useState(false);
  const [twofaLoading, setTwofaLoading] = useState(true);
  const [twofaBusy, setTwofaBusy] = useState(false);
  const [pendingSecret, setPendingSecret] = useState<string | null>(null);
  const [pendingUri, setPendingUri] = useState<string>("");
  const [confirmCode, setConfirmCode] = useState("");
  const [disableCode, setDisableCode] = useState("");

  // 开发模式
  const [devMode, setDevMode] = useState(false);
  const [devModeLoading, setDevModeLoading] = useState(true);
  const [devModeBusy, setDevModeBusy] = useState(false);
  // 调试面板 1：最近请求日志
  const [devLogs, setDevLogs] = useState<Array<Record<string, unknown>> | null>(null);
  const [devLogsLoading, setDevLogsLoading] = useState(false);
  // 调试面板 2：平台 Key 清单
  const [devPlatforms, setDevPlatforms] = useState<Array<Record<string, unknown>> | null>(null);
  const [devPlatformsLoading, setDevPlatformsLoading] = useState(false);
  // 调试面板 3：单条日志详情
  const [devLogId, setDevLogId] = useState("");
  const [devLogDetail, setDevLogDetail] = useState<Record<string, unknown> | null>(null);
  const [devLogDetailLoading, setDevLogDetailLoading] = useState(false);

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

  // ==================== 开发模式 ====================

  const loadDevMode = useCallback(async () => {
    setDevModeLoading(true);
    try {
      const res = await fetch("/api/admin/dev-mode");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { success?: boolean; data?: { enabled?: boolean } };
      setDevMode(json?.data?.enabled === true);
    } catch (err) {
      message.error(`${t("common:error")}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDevModeLoading(false);
    }
  }, [t]);

  const handleToggleDevMode = async (next: boolean) => {
    setDevModeBusy(true);
    try {
      const res = await fetch("/api/admin/dev-mode", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const json = (await res.json().catch(() => null)) as {
        success?: boolean;
        error?: { message?: string };
      } | null;
      if (!res.ok || !json?.success) {
        throw new Error(json?.error?.message || `HTTP ${res.status}`);
      }
      setDevMode(next);
      message.success(next ? t("devModeEnabledOn") : t("devModeEnabledOff"));
    } catch (err) {
      message.error(`${t("common:error")}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDevModeBusy(false);
    }
  };

  const loadDevLogs = useCallback(async () => {
    setDevLogsLoading(true);
    try {
      const res = await fetch("/api/admin/dev-mode/logs?minutes=60&limit=100");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        success?: boolean;
        data?: { items?: Array<Record<string, unknown>> };
      };
      setDevLogs(json?.data?.items ?? []);
    } catch (err) {
      message.error(`${t("common:error")}: ${err instanceof Error ? err.message : String(err)}`);
      setDevLogs([]);
    } finally {
      setDevLogsLoading(false);
    }
  }, [t]);

  const loadDevPlatforms = useCallback(async () => {
    setDevPlatformsLoading(true);
    try {
      const res = await fetch("/api/admin/dev-mode/platforms");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        success?: boolean;
        data?: { items?: Array<Record<string, unknown>> };
      };
      setDevPlatforms(json?.data?.items ?? []);
    } catch (err) {
      message.error(`${t("common:error")}: ${err instanceof Error ? err.message : String(err)}`);
      setDevPlatforms([]);
    } finally {
      setDevPlatformsLoading(false);
    }
  }, [t]);

  const loadDevLogDetail = useCallback(async () => {
    if (!devLogId.trim()) return;
    setDevLogDetailLoading(true);
    try {
      const res = await fetch(`/api/admin/dev-mode/log-detail?id=${encodeURIComponent(devLogId.trim())}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        success?: boolean;
        data?: Record<string, unknown>;
      };
      setDevLogDetail(json?.data ?? null);
    } catch (err) {
      message.error(`${t("common:error")}: ${err instanceof Error ? err.message : String(err)}`);
      setDevLogDetail(null);
    } finally {
      setDevLogDetailLoading(false);
    }
  }, [devLogId, t]);

  useEffect(() => {
    // 延迟到宏任务执行：loadPricing 首行同步 setLoading 会触发
    // react-hooks/set-state-in-effect（effect 体内禁止同步 setState）
    const timer = setTimeout(loadPricing, 0);
    const notifTimer = setTimeout(loadNotifications, 0);
    const twofaTimer = setTimeout(load2fa, 0);
    const devTimer = setTimeout(loadDevMode, 0);
    return () => {
      clearTimeout(timer);
      clearTimeout(notifTimer);
      clearTimeout(twofaTimer);
      clearTimeout(devTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 稳定引用供 memo 价格行使用：函数式更新不依赖外部快照
  const updateRow = useCallback((id: string, patch: Partial<PricingRow>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }, []);

  const removeRow = useCallback((id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }, []);

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
      const res = await fetch("/api/admin/pricing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "import-litellm" }),
      });
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
            ) : rows.length === 0 ? (
              <p className="text-sm text-zinc-400 py-4 text-center">
                {t("pricingEmpty")}
              </p>
            ) : (
              <div
                ref={pricingListRef}
                className="max-h-[60vh] overflow-auto rounded-md border border-zinc-100 dark:border-zinc-800"
              >
                <div
                  style={{
                    height: `${rowVirtualizer.getTotalSize()}px`,
                    width: "100%",
                    position: "relative",
                  }}
                >
                  {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                    const row = rows[virtualRow.index];
                    if (!row) return null;
                    return (
                      <div
                        key={row.id}
                        data-index={virtualRow.index}
                        ref={rowVirtualizer.measureElement}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          right: 0,
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
                        <PricingRowItem
                          row={row}
                          onUpdate={updateRow}
                          onRemove={removeRow}
                        />
                      </div>
                    );
                  })}
                </div>
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
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <span
                    className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs ${
                      notif.enabled
                        ? "bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300"
                        : "bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400"
                    }`}
                  >
                    {notif.enabled ? t("notif:enabled") : t("notif:disabled")}
                  </span>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    {t("notifChannels")}: <strong className="text-zinc-900 dark:text-zinc-100">{notif.channels.length}</strong>
                  </span>
                </div>

                <div className="flex flex-col sm:flex-row gap-2 pt-2 border-t border-zinc-100 dark:border-zinc-800">
                  <Link href="/admin/notifications" className="flex-1">
                    <Button variant="primary" size="sm" icon={<Bell className="w-4 h-4 mr-1" />} block>
                      {t("notifOpenPage")}
                    </Button>
                  </Link>
                  <Link href="/admin/backup">
                    <Button variant="secondary" size="sm" icon={<Database className="w-4 h-4 mr-1" />}>
                      {t("notifOpenBackup")}
                    </Button>
                  </Link>
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

        {/* ========== 开发模式 ========== */}
        <ProCard title={t("devModeTitle")}>
          <div className="space-y-4">
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{t("devModeDesc")}</p>

            {devModeLoading ? (
              <div className="flex items-center justify-center py-8 text-zinc-400">
                <Loader2 className="w-5 h-5 animate-spin" />
              </div>
            ) : (
              <>
                <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={devMode}
                    onChange={(e) => handleToggleDevMode(e.target.checked)}
                    disabled={devModeBusy}
                    className="w-4 h-4 accent-zinc-700 dark:accent-zinc-300"
                  />
                  {t("devModeEnabled")}
                  {devModeBusy && <Loader2 className="w-3 h-3 animate-spin ml-1" />}
                </label>
                <p className={`text-xs ${devMode ? "text-amber-600 dark:text-amber-400" : "text-zinc-400 dark:text-zinc-500"}`}>
                  {devMode ? t("devModeEnabledOn") : t("devModeEnabledOff")}
                </p>

                {/* 调试面板：仅开启时渲染。关闭时整块折叠为隐藏，避免无意义请求 */}
                {devMode && (
                  <div className="space-y-4 pt-2 border-t border-zinc-100 dark:border-zinc-800">
                    {/* 面板 1：最近请求日志 */}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                          {t("devModePanelLogs")}
                        </p>
                        <Button variant="ghost" size="sm" onClick={loadDevLogs} loading={devLogsLoading} icon={<Code2 className="w-3 h-3 mr-1" />}>
                          {t("devModeRefresh")}
                        </Button>
                      </div>
                      {devLogs === null ? (
                        <p className="text-xs text-zinc-400 py-2">{t("devModeEmpty")}</p>
                      ) : devLogs.length === 0 ? (
                        <p className="text-xs text-zinc-400 py-2">{t("devModeEmpty")}</p>
                      ) : (
                        <pre className="max-h-64 overflow-auto rounded-md bg-zinc-50 dark:bg-zinc-950 p-2 text-[11px] text-zinc-800 dark:text-zinc-200 border border-zinc-100 dark:border-zinc-800">
                          {JSON.stringify(devLogs, null, 2)}
                        </pre>
                      )}
                    </div>

                    {/* 面板 2：平台 Key 清单 */}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                          {t("devModePanelPlatforms")}
                        </p>
                        <Button variant="ghost" size="sm" onClick={loadDevPlatforms} loading={devPlatformsLoading} icon={<Code2 className="w-3 h-3 mr-1" />}>
                          {t("devModeRefresh")}
                        </Button>
                      </div>
                      {devPlatforms === null ? (
                        <p className="text-xs text-zinc-400 py-2">{t("devModeEmpty")}</p>
                      ) : devPlatforms.length === 0 ? (
                        <p className="text-xs text-zinc-400 py-2">{t("devModeEmpty")}</p>
                      ) : (
                        <pre className="max-h-64 overflow-auto rounded-md bg-zinc-50 dark:bg-zinc-950 p-2 text-[11px] text-zinc-800 dark:text-zinc-200 border border-zinc-100 dark:border-zinc-800">
                          {JSON.stringify(devPlatforms, null, 2)}
                        </pre>
                      )}
                    </div>

                    {/* 面板 3：单条日志详情 */}
                    <div>
                      <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-2">
                        {t("devModePanelLogDetail")}
                      </p>
                      <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
                        <input
                          value={devLogId}
                          onChange={(e) => setDevLogId(e.target.value)}
                          placeholder={t("devModeLogIdPlaceholder")}
                          className="h-8 w-full sm:flex-1 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-500"
                        />
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={loadDevLogDetail}
                          loading={devLogDetailLoading}
                          disabled={!devLogId.trim()}
                        >
                          {t("devModeRefresh")}
                        </Button>
                      </div>
                      {devLogDetail && (
                        <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-zinc-50 dark:bg-zinc-950 p-2 text-[11px] text-zinc-800 dark:text-zinc-200 border border-zinc-100 dark:border-zinc-800">
                          {JSON.stringify(devLogDetail, null, 2)}
                        </pre>
                      )}
                    </div>
                  </div>
                )}
              </>
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
