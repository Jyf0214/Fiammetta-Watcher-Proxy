import { useState, useRef, useCallback, useEffect } from "react";
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
  error?: string;
  skipReasons?: Record<string, number>;
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
  platforms: { labelKey: "dmStepPlatforms" },
  modelMaps: { labelKey: "dmStepModelMaps" },
  configs: { labelKey: "dmStepConfigs" },
  apiKeys: { labelKey: "dmStepApiKeys" },
  auditLogs: { labelKey: "dmStepAuditLogs" },
  requestLogs: { labelKey: "dmStepRequestLogs", detailKey: "dmStepRequestLogsDetail" },
  dailyStats: { labelKey: "dmStepDailyStats" },
};

// ==================== 导入前预览分析 ====================

interface ImportPreviewType {
  count: number;
  issues: number;
}

interface ImportPreview {
  total: number;
  issueTotal: number;
  types: Record<string, ImportPreviewType>;
}

/** 各类型必填字段与去重键（与后端 import.ts 校验规则对应的轻量提示） */
const PREVIEW_RULES: Record<
  string,
  { required: string[]; unique?: string; masked?: string }
> = {
  platforms: { required: ["name", "baseUrl"], unique: "name" },
  modelMaps: { required: ["alias"], unique: "alias" },
  configs: { required: ["key", "value"], unique: "key" },
  apiKeys: { required: ["key"], unique: "key", masked: "key" },
  auditLogs: { required: ["action"] },
  requestLogs: { required: ["model"] },
  dailyStats: { required: ["date", "model"] },
};

/** 解析导入文件，统计各类型条数与可疑记录（缺必填字段/重复/脱敏） */
function analyzeImportData(data: Record<string, unknown>): ImportPreview {
  const types: Record<string, ImportPreviewType> = {};
  let total = 0;
  let issueTotal = 0;

  for (const [type, rule] of Object.entries(PREVIEW_RULES)) {
    const arr = data[type];
    if (!Array.isArray(arr) || arr.length === 0) continue;

    const seen = new Set<string>();
    let issues = 0;
    for (const item of arr) {
      if (typeof item !== "object" || item === null) {
        issues++;
        continue;
      }
      const rec = item as Record<string, unknown>;
      const missing = rule.required.some(
        (f) => typeof rec[f] !== "string" || rec[f] === ""
      );
      const masked =
        !!rule.masked &&
        typeof rec[rule.masked] === "string" &&
        (rec[rule.masked] as string).includes("***");
      let duplicated = false;
      if (rule.unique && typeof rec[rule.unique] === "string") {
        const key = rec[rule.unique] as string;
        duplicated = seen.has(key);
        seen.add(key);
      }
      if (missing || masked || duplicated) issues++;
    }

    types[type] = { count: arr.length, issues };
    total += arr.length;
    issueTotal += issues;
  }

  return { total, issueTotal, types };
}

// ==================== 进度状态 ====================

interface StepProgress {
  labelKey: string;
  detailKey?: string;
  stepTotal: number;
  imported: number;
  skipped: number;
  status: "done" | "error";
  error?: string;
  skipReasons?: Record<string, number>;
}

export default function DataManagerPage() {
  const { t } = useTranslation("admin");
  const [exportType, setExportType] = useState<ExportType>("all");
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 流式导入的 AbortController 引用（组件卸载时中止未完成的导入）
  const importAbortRef = useRef<AbortController | null>(null);

  // 组件卸载时中止仍在进行的导入，避免请求泄漏与卸载后 setState
  useEffect(() => {
    return () => importAbortRef.current?.abort();
  }, []);

  // 流式导入进度状态
  const [totalProcessed, setTotalProcessed] = useState(0);
  const [totalRecords, setTotalRecords] = useState(0);
  const [stepProgressList, setStepProgressList] = useState<StepProgress[]>([]);
  const [currentStepKey, setCurrentStepKey] = useState<string | null>(null);

  // 导入前预览状态（解析后先预览，确认后才写入）
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [pendingImport, setPendingImport] = useState<Record<string, unknown> | null>(null);

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
      label: t("dmSystemConfig"),
      desc: t("dmSystemConfigDesc"),
      icon: <Cloud size={16} />,
      tag: t("dmSystemConfigTag"),
      tagColor: "bg-blue-50 text-blue-600 border-blue-200",
    },
    {
      value: "data",
      label: t("dmBusinessData"),
      desc: t("dmBusinessDataDesc"),
      icon: <FileText size={16} />,
    },
    {
      value: "all",
      label: t("dmAllExport"),
      desc: t("dmAllExportDesc"),
      icon: <Database size={16} />,
      tag: t("dmAllExportTag"),
      tagColor: "bg-amber-50 text-amber-600 border-amber-200",
    },
  ];

  const handleExport = async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams({ type: exportType });
      const res = await fetch(`/api/admin/export?${params}`);

      if (!res.ok) {
        const error: Record<string, any> = await res.json();
        throw new Error(error.error || t("dmErrExport"));
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

      message.success(t("dmExportSuccess"));
    } catch (err) {
      message.error(err instanceof Error ? err.message : t("dmErrExport"));
    } finally {
      setExporting(false);
    }
  };

  const processImportFile = useCallback(
    (file: File) => {
      // 解析文件并生成预览，用户确认后再写入系统
      file
        .text()
        .then((text) => {
          const data = JSON.parse(text);

          if (!data.version || !data.exportedAt) {
            throw new Error(t("dmErrInvalidFormat"));
          }

          const preview = analyzeImportData(data);
          if (preview.total === 0) {
            message.info(t("dmPreviewEmpty"));
            return;
          }
          setPendingImport(data);
          setImportPreview(preview);
        })
        .catch((err) => {
          message.error(err instanceof Error ? err.message : t("dmErrExport"));
        });
    },
    [t]
  );

  /** 流式导入执行（解析与校验已在前置预览完成） */
  const doImport = useCallback(
    async (data: Record<string, unknown>) => {
      setImporting(true);
      setImportResult(null);
      setTotalProcessed(0);
      setTotalRecords(0);
      setStepProgressList([]);
      setCurrentStepKey(null);

      const controller = new AbortController();
      importAbortRef.current = controller;

      try {
        // 发起流式请求
        const res = await fetch("/api/admin/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
          signal: controller.signal,
        });

        if (!res.ok) {
          const err: Record<string, any> = await res.json();
          throw new Error(err.error || t("dmErrExport"));
        }

        // 读取 NDJSON 流
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // 只在完整行上解析（以 \n 结尾）
          let newlineIdx: number;
          while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 1);

            if (!line) continue;

            try {
              const event = JSON.parse(line);

              if (event.type === "progress") {
                const ev = event as ProgressEvent;
                setTotalProcessed(ev.totalProcessed);
                setTotalRecords(ev.totalRecords);
                setCurrentStepKey(ev.step);
                setStepProgressList((prev) => {
                  const idx = prev.findIndex((p) => p.labelKey === STEP_LABELS[ev.step]?.labelKey);
                  const hasError = !!ev.error;
                  const newEntry: StepProgress = {
                    labelKey: STEP_LABELS[ev.step]?.labelKey || ev.step,
                    detailKey: STEP_LABELS[ev.step]?.detailKey,
                    stepTotal: ev.stepTotal,
                    imported: ev.imported,
                    skipped: ev.skipped,
                    status: hasError ? "error" : "done",
                    error: ev.error,
                    skipReasons: ev.skipReasons,
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
                  message.success(ev.message.replace(/\n/g, " | "));
                }
              } else if (event.type === "error") {
                const ev = event as ErrorEvent;
                throw new Error(ev.error);
              }
            } catch (parseErr) {
              // JSON 解析失败：跳过坏行继续；流内 error 事件（导入失败）则关闭读取并向上抛出中止导入
              if (parseErr instanceof SyntaxError) {
                console.warn("[import] failed to parse progress event:", parseErr);
              } else {
                await reader.cancel().catch(() => {});
                throw parseErr;
              }
            }
          }
        }

        // 处理 buffer 中剩余的内容（最后一行可能没有 \n）
        if (buffer.trim()) {
          try {
            const event = JSON.parse(buffer.trim());
            if (event.type === "complete") {
              const ev = event as CompleteEvent;
              setImportResult({
                success: ev.success,
                message: ev.message,
                details: ev.details,
              });
              if (ev.success) message.success(ev.message.replace(/\n/g, " | "));
            }
          } catch {
            // 忽略最后不完整的行
          }
        }
      } catch (err) {
        // 主动中止（组件卸载）：静默退出，不弹错误提示
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        message.error(err instanceof Error ? err.message : t("dmErrExport"));
        setImportResult({
          success: false,
          message: err instanceof Error ? err.message : t("dmErrExport"),
        });
      } finally {
        importAbortRef.current = null;
        setImporting(false);
        setCurrentStepKey(null);
      }
    },
    [t]
  );

  /** 用户确认预览后执行流式导入 */
  const confirmImport = useCallback(() => {
    if (!pendingImport) return;
    setImportPreview(null);
    setPendingImport(null);
    doImport(pendingImport);
  }, [pendingImport, doImport]);

  /** 取消导入预览 */
  const cancelImport = useCallback(() => {
    setImportPreview(null);
    setPendingImport(null);
  }, []);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const isJson = file.type === "application/json" || file.name.endsWith(".json");
      if (!isJson) {
        message.error(t("dmErrJsonOnly"));
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        message.error(t("dmErrFileTooLarge"));
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
        message.error(t("dmErrJsonOnly"));
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
              {t("dmImporting")}
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
          return (
            <div key={i}>
              <div className="flex items-center gap-2 text-xs">
                {sp.status === "done" && sp.imported > 0 ? (
                  <CheckCircle size={13} className="text-emerald-500 flex-shrink-0" />
                ) : sp.status === "error" ? (
                  <AlertTriangle size={13} className="text-red-500 flex-shrink-0" />
                ) : (
                  <div className="h-3.5 w-3.5 rounded-full border border-zinc-300 dark:border-zinc-600 flex-shrink-0" />
                )}
                <span className="text-zinc-600 dark:text-zinc-400 min-w-0">
                  {t(`${sp.labelKey}`)}
                </span>
                <span className="text-zinc-400 dark:text-zinc-500 tabular-nums ml-auto flex-shrink-0">
                  {sp.imported > 0 && <span className="text-emerald-500">+{sp.imported}</span>}
                  {sp.skipped > 0 && <span className="ml-1">{t("dmSkip")} {sp.skipped}</span>}
                  {sp.imported === 0 && sp.skipped === 0 && <span>-</span>}
                </span>
              </div>
              {sp.status === "error" && sp.error && (
                <div className="text-xs text-red-500 dark:text-red-400 ml-5 truncate" title={sp.error}>
                  {sp.error}
                </div>
              )}
              {sp.skipped > 0 && sp.skipReasons && Object.keys(sp.skipReasons).length > 0 && (
                <div className="ml-5 mt-1 space-y-0.5">
                  {Object.entries(sp.skipReasons).map(([reason, count]) => (
                    <div key={reason} className="text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-1">
                      <span>·</span>
                      <span>{reason}</span>
                      <span className="text-zinc-400 dark:text-zinc-500">×{count}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {/* 当前正在处理的步骤（尚未完成） */}
        {currentStepKey && !stepProgressList.find((sp) => sp.labelKey === STEP_LABELS[currentStepKey]?.labelKey) && (
          <div className="flex items-center gap-2 text-xs">
            <Loader2 size={13} className="text-blue-500 animate-spin flex-shrink-0" />
            <span className="text-blue-600 dark:text-blue-400 font-medium">
              {t(`${STEP_LABELS[currentStepKey]?.labelKey || currentStepKey}`)}
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
          title={t("dataManager")}
          description={t("dataManagerDesc")}
        />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* ========== 导出区域 ========== */}
          <ProCard title={t("dmExport")}>
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  {t("dmSelectType")}
                </label>
                <div className="space-y-2">
                  {exportOptions.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => setExportType(opt.value)}
                      className={cn(
                        "w-full flex items-center gap-3 p-3 rounded-xl border text-left transition-all duration-200",
                        exportType === opt.value
                          ? "border-zinc-900 dark:border-zinc-100 bg-zinc-50 dark:bg-zinc-800/50"
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
                {t("dmExportBtn")}
              </Button>
            </div>
          </ProCard>

          {/* ========== 导入区域 ========== */}
          <ProCard title={t("dmImport")}>
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
                    <RefreshCw size={20} className="animate-spin" />
                  ) : (
                    <Upload size={20} />
                  )}
                </div>

                <div className="text-center">
                  <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    {importing ? t("dmImporting") : t("dmDropHint")}
                  </p>
                  <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">
                    {t("dmFileHint")}
                  </p>
                </div>
              </div>

              {/* 导入前预览（确认后才写入系统） */}
              {importPreview && !importing && (
                <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <FileText size={14} className="text-zinc-400" />
                    <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                      {t("dmPreviewTitle")}
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    {Object.entries(importPreview.types).map(([key, v]) => (
                      <div key={key} className="flex items-center justify-between text-xs">
                        <span className="text-zinc-600 dark:text-zinc-400">
                          {t(`${STEP_LABELS[key]?.labelKey || key}`)}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <span className="text-zinc-500 dark:text-zinc-400 tabular-nums">
                            {v.count.toLocaleString()} {t("dmPreviewRecords")}
                          </span>
                          {v.issues > 0 && (
                            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
                              <AlertTriangle size={11} />
                              {v.issues}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  {importPreview.issueTotal > 0 && (
                    <p className="text-[11px] text-amber-600 dark:text-amber-400">
                      {t("dmPreviewIssueHint")}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Button
                      variant="primary"
                      icon={<Upload size={14} />}
                      onClick={confirmImport}
                      block
                    >
                      {t("dmPreviewConfirm")}
                    </Button>
                    <Button variant="secondary" onClick={cancelImport}>
                      {t("dmPreviewCancel")}
                    </Button>
                  </div>
                </div>
              )}

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
                        "text-sm font-medium whitespace-pre-line",
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
                            {key}
                          </span>
                          <div className="flex items-center gap-1.5">
                            {value.imported > 0 && (
                              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                                +{value.imported}
                              </span>
                            )}
                            {value.skipped > 0 && (
                              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                                {t("dmSkip")} {value.skipped}
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
              {t("dmTips")}
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-zinc-600 dark:text-zinc-400">
            <div className="space-y-1.5">
              <p className="font-medium text-zinc-700 dark:text-zinc-300">
                {t("dmExportScenarios")}
              </p>
              <p>{t("dmTipMigrate")}</p>
              <p>{t("dmTipBackup")}</p>
              <p>{t("dmTipCopy")}</p>
            </div>
            <div className="space-y-1.5">
              <p className="font-medium text-zinc-700 dark:text-zinc-300">
                {t("dmImportNotes")}
              </p>
              <p>{t("dmTipNoOverwrite")}</p>
              <p>{t("dmTipSkipExisting")}</p>
              <p>{t("dmTipCheckStatus")}</p>
            </div>
          </div>
        </ProCard>
      </PageContainer>
    </AdminLayout>
  );
}
