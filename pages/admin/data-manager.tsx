import { useState, useRef, useCallback } from "react";
import { toast } from "@lobehub/ui";
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

      toast.success(t("admin.dm_export_success"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("admin.dm_err_export"));
    } finally {
      setExporting(false);
    }
  };

  const processImportFile = useCallback(
    async (file: File) => {
      setImporting(true);
      setImportResult(null);

      try {
        const text = await file.text();
        const data = JSON.parse(text);

        if (!data.version || !data.exportedAt) {
          throw new Error(t("admin.dm_err_invalid_format"));
        }

        const res = await fetch("/api/admin/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });

        const result = await res.json();
        setImportResult(result);

        if (result.success) {
          toast.success(result.message);
        } else {
          toast.error(result.error || t("admin.dm_err_export"));
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("admin.dm_err_export"));
        setImportResult({
          success: false,
          message: err instanceof Error ? err.message : t("admin.dm_err_export"),
        });
      } finally {
        setImporting(false);
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
        toast.error(t("admin.dm_err_json_only"));
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        toast.error(t("admin.dm_err_file_too_large"));
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
        toast.error(t("admin.dm_err_json_only"));
        return;
      }
      processImportFile(file);
    },
    [processImportFile, t]
  );

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
              {/* 导出类型选择 */}
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

              {/* 导出按钮 */}
              <Button
                variant="primary"
                icon={<Download />}
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
                    <RefreshCw className="text-xl animate-spin" />
                  ) : (
                    <Upload className="text-xl" />
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

              {/* 导入结果 */}
              {importResult && (
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
