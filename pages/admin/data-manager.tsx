import { useState, useRef, useCallback } from "react";
import { message } from "antd";
import {
  Download,
  Upload,
  Database,
  Cloud,
  FileText,
  CheckCircle,
  AlertTriangle,
  RefreshCw,
  Info,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import { cn } from "@/lib/ui";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import AdminLayout from "@/components/AdminLayout";

type ExportType = "system" | "data" | "all";

interface ImportResult {
  success: boolean;
  message: string;
  details?: Record<string, { imported: number; skipped: number }>;
}

/** 流式进度事件 */
interface ProgressEvent {
  type: "progress";
  step: string;
  stepTotal: number;
  imported: number;
  skipped: number;
  totalProcessed: number;
  totalRecords: number;
}

/** 流式完成事件 */
interface CompleteEvent {
  type: "complete";
  success: boolean;
  message: string;
  details?: Record<string, { imported: number; skipped: number }>;
}

/** 流式错误事件 */
interface ErrorEvent {
  type: "error";
  error: string;
}

// ==================== 导入步骤定义（用于显示名称） ====================

const STEP_LABELS: Record<string, { labelKey: string; detailKey?: string }> = {
  proxyPools: { labelKey: "dm_step_proxy_pools" },
  platforms: { labelKey: "dm_step_platforms" },
  modelMaps: { labelKey: "dm_step_model_maps" },
  proxies: { labelKey: "dm_step_proxies" },
  plans: { labelKey: "dm_step_plans" },
  configs: { labelKey: "dm_step_configs" },
  apiKeys: { labelKey: "dm_step_api_keys" },
  auditLogs: { labelKey: "dm_step_audit_logs" },
  systemEvents: { labelKey: "dm_step_system_events" },
  requestLogs: { labelKey: "dm_step_request_logs", detailKey: "dm_step_request_logs_detail" },
};

// ==================== 进度状态 ====================

interface StepProgress {
  labelKey: string;
  detailKey?: string;
  stepTotal: number;
  imported: number;
  skipped: number;
  status: "done" | "error";
}

/** 格式化导入字段名 */
function formatImportKey(key: string): string {
  const map: Record<string, string> = {
    platforms: "platforms",
    modelMaps: "modelMaps",
    proxies: "proxies",
    proxyPools: "proxyPools",
    plans: "plans",
    apiKeys: "apiKeys",
    configs: "configs",
    requestLogs: "requestLogs",
    dailyStats: "dailyStats",
    auditLogs: "auditLogs",
    systemEvents: "systemEvents",
  };
  return map[key] || key;
}

export default function DataManagerPage() {
  const { t } = useTranslation();
  const [exportType, setExportType] = useState<ExportType>("all");
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 流式导入进度状态
  const [totalProcessed, setTotalProcessed] = useState(0);
  const [totalRecords, setTotalRecords] = useState(0);
  const [stepProgressList, setStepProgressList] = useState<StepProgress[]>([]);
  const [currentStepKey, setCurrentStepKey] = useState<string | null>(null);

  /** 导出类型配置 */
  const exportOptions: {
    value: ExportType;
    label: string;
    desc: string;
    icon: React.ReactNode;
    tag?: string;
    tagColor?: string;
  }[] = [
    {
      value: "system",
      label: t("admin.dm_system_config"),
      desc: t("admin.dm_system_config_desc"),
      icon: <Cloud size={16} />,
      tag: t("admin.dm_system_config_tag"),
      tagColor: "bg-blue-50 text-blue-600 border-blue-200",
    },
    {
      value: "data",
      label: t("admin.dm_business_data"),
      desc: t("admin.dm_business_data_desc"),
      icon: <FileText size={16} />,
    },
    {
      value: "all",
      label: t("admin.dm_all_export"),
      desc: t("admin.dm_all_export_desc"),
      icon: <Database size={16} />,
      tag: t("admin.dm_all_export_tag"),
      tagColor: "bg-amber-50 text-amber-600 border-amber-200",
    },
  ];

  const handleExport = async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams({ type: exportType });
      const res = await fetch(`/api/admin/export?${params}`);

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || t("admin.dm_err_export"));
      }

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `fwp-export-${exportType}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      message.success(t("admin.dm_export_success"));
    } catch (err) {
      message.error(err instanceof Error ? err.message : t("admin.dm_err_export"));
    } finally {
      setExporting(false);
    }
  };

  const processImportFile = useCallback(
    async (file: File) => {
      setImporting(true);
      setImportResult(null);
      setTotalProcessed(0);
      setTotalRecords(0);
      setStepProgressList([]);
      setCurrentStepKey(null);

      try {
        // 解析文件
        const text = await file.text();
        const data = JSON.parse(text);

        if (!data.version || !data.exportedAt) {
          throw new Error(t("admin.dm_err_invalid_format"));
        }

        // 发起流式请求
        const res = await fetch("/api/admin/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || t("admin.dm_err_export"));
        }

        // 读取 NDJSON 流
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            const event = JSON.parse(line);

            if (event.type === "progress") {
              const ev = event as ProgressEvent;
              setTotalProcessed(ev.totalProcessed);
              setTotalRecords(ev.totalRecords);
              setCurrentStepKey(ev.step);
              setStepProgressList((prev) => {
                // 检查是否已有该 step 的记录
                const idx = prev.findIndex((p) => p.labelKey === STEP_LABELS[ev.step]?.labelKey);
                const newEntry: StepProgress = {
                  labelKey: STEP_LABELS[ev.step]?.labelKey || ev.step,
                  detailKey: STEP_LABELS[ev.step]?.detailKey,
                  stepTotal: ev.stepTotal,
                  imported: ev.imported,
                  skipped: ev.skipped,
                  status: ev.imported === 0 && ev.skipped === ev.stepTotal ? "error" : "done",
                };
                if (idx >= 0) {
                  const next = [...prev];
                  next[idx] = newEntry;
                  return next;
                }
                return [...prev, newEntry];
              });
            } else if (event.type === "complete") {
              const ev = event as CompleteEvent;
              setImportResult({
                success: ev.success,
                message: ev.message,
                details: ev.details,
              });
              if (ev.success) {
                message.success(ev.message);
              }
            } else if (event.type === "error") {
              const ev = event as ErrorEvent;
              throw new Error(ev.error);
            }
          }
        }
      } catch (err) {
        message.error(err instanceof Error ? err.message : t("admin.dm_err_export"));
        setImportResult({
          success: false,
          message: err instanceof Error ? err.message : t("admin.dm_err_export"),
        });
      } finally {
        setImporting(false);
        setCurrentStepKey(null);
      }
    },
    [t]
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const isJson = file.type === "application/json" || file.name.endsWith(".json");
      if (!isJson) {
        message.error(t("admin.dm_err_json_only"));
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        message.error(t("admin.dm_err_file_too_large"));
        return;
      }

      processImportFile(file);
      e.target.value = "";
    },
    [processImportFile, t]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (!file) return;

      if (!file.name.endsWith(".json")) {
        message.error(t("admin.dm_err_json_only"));
        return;
      }
      processImportFile(file);
    },
    [processImportFile, t]
  );

  /** 渲染导入进度 */
  const renderImportProgress = () => {
    if (totalRecords === 0 && stepProgressList.length === 0) return null;

    const percent = totalRecords > 0 ? Math.round((totalProcessed / totalRecords) * 100) : 0;

    return (
      <div className="space-y-3 mt-4">
        {/* 总进度条 */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-zinc-500 dark:text-zinc-400">
              {t("admin.dm_importing")}
            </span>
            <span className="text-zinc-500 dark:text-zinc-400 tabular-nums">
              {totalProcessed.toLocaleString()}/{totalRecords.toLocaleString()} ({percent}%)
            </span>
          </div>
          <div className="h-1.5 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 dark:bg-blue-400 rounded-full transition-all duration-300"
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>

        {/* 各步骤明细 */}
        {stepProgressList.map((sp, i) => {
          const isCurrent = currentStepKey && STEP_LABELS[currentStepKey]?.labelKey === sp.labelKey;
          const stepPercent = sp.stepTotal > 0 ? Math.round(((sp.imported + sp.skipped) / sp.stepTotal) * 100) : 0;

          return (
            <div key={i} className="flex items-center gap-2 text-xs">
              {sp.status === "done" && sp.imported > 0 ? (
                <CheckCircle size={13} className="text-emerald-500 flex-shrink-0" />
              ) : sp.status === "error" ? (
                <AlertTriangle size={13} className="text-red-500 flex-shrink-0" />
              ) : (
                <div className="h-3.5 w-3.5 rounded-full border border-zinc-300 dark:border-zinc-600 flex-shrink-0" />
              )}
              <span className="text-zinc-600 dark:text-zinc-400 min-w-0">
                {t(`admin.${sp.labelKey}`)}
              </span>
              <span className="text-zinc-400 dark:text-zinc-500 tabular-nums ml-auto flex-shrink-0">
                {sp.imported > 0 && <span className="text-emerald-500">+{sp.imported}</span>}
                {sp.skipped > 0 && <span className="ml-1">{t("admin.dm_skip")} {sp.skipped}</span>}
                {sp.imported === 0 && sp.skipped === 0 && <span>-</span>}
              </span>
            </div>
          );
        })}

        {/* 当前正在处理的步骤（尚未完成） */}
        {currentStepKey && !stepProgressList.find((sp) => sp.labelKey === STEP_LABELS[currentStepKey]?.labelKey) && (
          <div className="flex items-center gap-2 text-xs">
            <Loader2 size={13} className="text-blue-500 animate-spin flex-shrink-0" />
            <span className="text-blue-600 dark:text-blue-400 font-medium">
              {t(`admin.${STEP_LABELS[currentStepKey]?.labelKey || currentStepKey}`)}
            </span>
            <span className="text-zinc-400 dark:text-zinc-500 ml-auto">
              ...
            </span>
          </div>
        )}
      </div>
    );
  };

  return (
    <AdminLayout>
      <PageContainer>
        <PageHeader
          icon={<Database size={20} className="text-zinc-500 dark:text-zinc-400" />}
          title={t("admin.data_manager")}
          description={t("admin.data_manager_desc")}
        />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* ========== 导出区域 ========== */}
          <ProCard title={t("admin.dm_export")}>
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  {t("admin.dm_select_type")}
                </label>
                <div className="space-y-2">
                  {exportOptions.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => setExportType(opt.value)}
                      className={cn(
                        "w-full flex items-center gap-3 p-3 rounded-xl border text-left transition-all duration-200",
                        exportType === opt.value
                          ? "border-zinc-900 dark:border-zinc-100 bg-zinc-50 dark:bg-zinc-800/50 shadow-sm"
                          : "border-zinc-200 dark:border-zinc-700 hover:border-zinc-300 dark:hover:border-zinc-600 hover:bg-zinc-50/50 dark:hover:bg-zinc-800/30"
                      )}
                    >
                      <div
                        className={cn(
                          "flex h-9 w-9 items-center justify-center rounded-lg text-sm flex-shrink-0",
                          exportType === opt.value
                            ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                            : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                        )}
                      >
                        {opt.icon}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                            {opt.label}
                          </span>
                          {opt.tag && (
                            <span
                              className={cn(
                                "text-[10px] font-medium px-1.5 py-0.5 rounded-md border",
                                opt.tagColor
                              )}
                            >
                              {opt.tag}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                          {opt.desc}
                        </p>
                      </div>
                      <div
                        className={cn(
                          "h-4 w-4 rounded-full border-2 flex-shrink-0 transition-colors",
                          exportType === opt.value
                            ? "border-zinc-900 dark:border-zinc-100 bg-zinc-900 dark:bg-zinc-100"
                            : "border-zinc-300 dark:border-zinc-600"
                        )}
                      >
                        {exportType === opt.value && (
                          <div className="h-full w-full flex items-center justify-center">
                            <div className="h-1.5 w-1.5 rounded-full bg-white dark:bg-zinc-900" />
                          </div>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <Button
                variant="primary"
                icon={<Download size={14} />}
                onClick={handleExport}
                loading={exporting}
                block
              >
                {t("admin.dm_export_btn")}
              </Button>
            </div>
          </ProCard>

          {/* ========== 导入区域 ========== */}
          <ProCard title={t("admin.dm_import")}>
            <div className="space-y-4">
              {/* 上传区域 */}
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => !importing && fileInputRef.current?.click()}
                className={cn(
                  "relative flex flex-col items-center justify-center gap-3 p-8 rounded-xl border-2 border-dashed cursor-pointer transition-all duration-200",
                  dragOver
                    ? "border-zinc-900 dark:border-zinc-100 bg-zinc-50 dark:bg-zinc-800/50"
                    : "border-zinc-200 dark:border-zinc-700 hover:border-zinc-300 dark:hover:border-zinc-600 hover:bg-zinc-50/50 dark:hover:bg-zinc-800/30",
                  importing && "opacity-50 cursor-not-allowed"
                )}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json"
                  className="hidden"
                  onChange={handleFileSelect}
                />

                <div
                  className={cn(
                    "flex h-12 w-12 items-center justify-center rounded-xl transition-colors",
                    dragOver
                      ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                      : "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500"
                  )}
                >
                  {importing ? (
                    <RefreshCw size={14} className="text-xl animate-spin" />
                  ) : (
                    <Upload size={14} className="text-xl" />
                  )}
                </div>

                <div className="text-center">
                  <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    {importing ? t("admin.dm_importing") : t("admin.dm_drop_hint")}
                  </p>
                  <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">
                    {t("admin.dm_file_hint")}
                  </p>
                </div>
              </div>

              {/* 流式导入进度 */}
              {importing && renderImportProgress()}

              {/* 导入结果 */}
              {importResult && !importing && (
                <div
                  className={cn(
                    "rounded-xl border p-4",
                    importResult.success
                      ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-800 dark:bg-emerald-900/20"
                      : "border-red-200 bg-red-50/50 dark:border-red-800 dark:bg-red-900/20"
                  )}
                >
                  <div className="flex items-center gap-2 mb-3">
                    {importResult.success ? (
                      <CheckCircle className="text-emerald-500 text-base" />
                    ) : (
                      <AlertTriangle className="text-red-500 text-base" />
                    )}
                    <span
                      className={cn(
                        "text-sm font-medium",
                        importResult.success
                          ? "text-emerald-700 dark:text-emerald-400"
                          : "text-red-700 dark:text-red-400"
                      )}
                    >
                      {importResult.message}
                    </span>
                  </div>

                  {importResult.details && (
                    <div className="space-y-1.5">
                      {Object.entries(importResult.details).map(([key, value]) => (
                        <div
                          key={key}
                          className="flex items-center justify-between text-xs"
                        >
                          <span className="text-zinc-600 dark:text-zinc-400">
                            {formatImportKey(key)}
                          </span>
                          <div className="flex items-center gap-1.5">
                            {value.imported > 0 && (
                              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                                +{value.imported}
                              </span>
                            )}
                            {value.skipped > 0 && (
                              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                                {t("admin.dm_skip")} {value.skipped}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </ProCard>
        </div>

        {/* ========== 使用提示 ========== */}
        <ProCard className="mt-6" bodyClassName="p-4">
          <div className="flex items-start gap-2 mb-3">
            <Info className="text-zinc-400 mt-0.5 flex-shrink-0" />
            <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              {t("admin.dm_tips")}
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-zinc-600 dark:text-zinc-400">
            <div className="space-y-1.5">
              <p className="font-medium text-zinc-700 dark:text-zinc-300">
                {t("admin.dm_export_scenarios")}
              </p>
              <p>{t("admin.dm_tip_migrate")}</p>
              <p>{t("admin.dm_tip_backup")}</p>
              <p>{t("admin.dm_tip_copy")}</p>
            </div>
            <div className="space-y-1.5">
              <p className="font-medium text-zinc-700 dark:text-zinc-300">
                {t("admin.dm_import_notes")}
              </p>
              <p>{t("admin.dm_tip_no_overwrite")}</p>
              <p>{t("admin.dm_tip_skip_existing")}</p>
              <p>{t("admin.dm_tip_check_status")}</p>
            </div>
          </div>
        </ProCard>
      </PageContainer>
    </AdminLayout>
  );
}
