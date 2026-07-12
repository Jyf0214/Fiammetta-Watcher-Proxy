"use client";

import { useState, useRef, useCallback } from "react";
import { message } from "antd";
import {
  DownloadOutlined,
  UploadOutlined,
  DatabaseOutlined,
  CloudServerOutlined,
  FileTextOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  ReloadOutlined,
  InfoCircleOutlined,
} from "@ant-design/icons";
import { Button } from "@/components/ui/Button";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import { cn } from "@/lib/ui";

type ExportType = "system" | "data" | "all";

interface ImportResult {
  success: boolean;
  message: string;
  details?: Record<string, { imported: number; skipped: number }>;
}

/** 导出类型配置 */
const EXPORT_OPTIONS: {
  value: ExportType;
  label: string;
  desc: string;
  icon: React.ReactNode;
  tag?: string;
  tagColor?: string;
}[] = [
  {
    value: "system",
    label: "系统配置",
    desc: "平台、模型映射、代理、套餐等配置数据",
    icon: <CloudServerOutlined />,
    tag: "推荐",
    tagColor: "bg-blue-50 text-blue-600 border-blue-200",
  },
  {
    value: "data",
    label: "业务数据",
    desc: "API Keys、请求日志、统计、审计日志等",
    icon: <FileTextOutlined />,
  },
  {
    value: "all",
    label: "全部导出",
    desc: "包含以上所有数据",
    icon: <DatabaseOutlined />,
    tag: "完整备份",
    tagColor: "bg-amber-50 text-amber-600 border-amber-200",
  },
];

/** 格式化导入字段名 */
function formatImportKey(key: string): string {
  const map: Record<string, string> = {
    platforms: "平台",
    modelMaps: "模型映射",
    proxies: "代理",
    proxyPools: "代理池",
    plans: "套餐模板",
    apiKeys: "API Keys",
    configs: "系统配置",
    requestLogs: "请求日志",
    dailyStats: "每日统计",
    auditLogs: "审计日志",
    systemEvents: "系统事件",
  };
  return map[key] || key;
}

export default function DataManagerPage() {
  const [exportType, setExportType] = useState<ExportType>("all");
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExport = async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams({ type: exportType });
      const res = await fetch(`/api/admin/export?${params}`);

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "导出失败");
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

      message.success("导出成功");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "导出失败");
    } finally {
      setExporting(false);
    }
  };

  const processImportFile = useCallback(async (file: File) => {
    setImporting(true);
    setImportResult(null);

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (!data.version || !data.exportedAt) {
        throw new Error("无效的导入文件格式");
      }

      const res = await fetch("/api/admin/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      const result = await res.json();
      setImportResult(result);

      if (result.success) {
        message.success(result.message);
      } else {
        message.error(result.error || "导入失败");
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : "导入失败");
      setImportResult({
        success: false,
        message: err instanceof Error ? err.message : "导入失败",
      });
    } finally {
      setImporting(false);
    }
  }, []);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const isJson = file.type === "application/json" || file.name.endsWith(".json");
      if (!isJson) {
        message.error("只能导入 JSON 文件");
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        message.error("文件大小不能超过 10MB");
        return;
      }

      processImportFile(file);
      e.target.value = "";
    },
    [processImportFile]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (!file) return;

      if (!file.name.endsWith(".json")) {
        message.error("只能导入 JSON 文件");
        return;
      }
      processImportFile(file);
    },
    [processImportFile]
  );

  return (
    <PageContainer>
      <PageHeader
        icon={<DatabaseOutlined size={20} className="text-zinc-500 dark:text-zinc-400" />}
        title="数据管理"
        description="导出和导入系统数据，支持备份和迁移"
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ========== 导出区域 ========== */}
        <ProCard title="数据导出">
          <div className="space-y-4">
            {/* 导出类型选择 */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                选择导出类型
              </label>
              <div className="space-y-2">
                {EXPORT_OPTIONS.map((opt) => (
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
              icon={<DownloadOutlined />}
              onClick={handleExport}
              loading={exporting}
              block
            >
              导出数据
            </Button>
          </div>
        </ProCard>

        {/* ========== 导入区域 ========== */}
        <ProCard title="数据导入">
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
                  <ReloadOutlined className="text-xl animate-spin" />
                ) : (
                  <UploadOutlined className="text-xl" />
                )}
              </div>

              <div className="text-center">
                <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  {importing ? "正在导入..." : "点击或拖拽文件到此处"}
                </p>
                <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">
                  支持 .json 格式，最大 10MB
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
                    <CheckCircleOutlined className="text-emerald-500 text-base" />
                  ) : (
                    <ExclamationCircleOutlined className="text-red-500 text-base" />
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
                              跳过 {value.skipped}
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
          <InfoCircleOutlined className="text-zinc-400 mt-0.5 flex-shrink-0" />
          <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">使用提示</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-zinc-600 dark:text-zinc-400">
          <div className="space-y-1.5">
            <p className="font-medium text-zinc-700 dark:text-zinc-300">导出场景</p>
            <p>• 迁移到新服务器时，先导出再导入</p>
            <p>• 定期备份系统配置</p>
            <p>• 复制配置到其他环境</p>
          </div>
          <div className="space-y-1.5">
            <p className="font-medium text-zinc-700 dark:text-zinc-300">导入注意事项</p>
            <p>• 仅导入新数据，不会覆盖或删除现有数据</p>
            <p>• 已存在的数据（按名称或地址匹配）会被跳过</p>
            <p>• 导入后建议检查平台配置</p>
          </div>
        </div>
      </ProCard>
    </PageContainer>
  );
}
