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
  CircleDollarSign,
  Download,
  Loader2,
  Plus,
  Save,
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

function SettingsContent() {
  const { t } = useTranslation("settings");
  const [rows, setRows] = useState<PricingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);

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

  useEffect(() => {
    // 延迟到宏任务执行：loadPricing 首行同步 setLoading 会触发
    // react-hooks/set-state-in-effect（effect 体内禁止同步 setState）
    const timer = setTimeout(loadPricing, 0);
    return () => clearTimeout(timer);
  }, [loadPricing]);

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
              <Button variant="secondary" size="sm" onClick={handleImport} disabled={importing || saving || loading}>
                {importing ? (
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                ) : (
                  <Download className="w-4 h-4 mr-1" />
                )}
                {importing ? t("pricingImporting") : t("pricingImportLiteLLM")}
              </Button>
              <Button variant="primary" size="sm" onClick={handleSave} disabled={saving || importing || loading}>
                {saving ? (
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                ) : (
                  <Save className="w-4 h-4 mr-1" />
                )}
                {saving ? t("pricingSaving") : t("common:save")}
              </Button>
            </div>
          </div>
        </ProCard>
      </PageContainer>
    </AdminLayout>
  );
}

export default function AdminSettings() {
  return <SettingsContent />;
}
