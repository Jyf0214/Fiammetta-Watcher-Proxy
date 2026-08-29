/**
 * 加密备份中心 — 独立页面
 *
 * 解决"备份功能是典型最小实现"问题：此前完全无前端页面，所有备份配置和
 * 触发必须经 SQL / 环境变量 / 外部 cron。本页提供：
 *
 * 1. 立即执行一次全量备份（POST /api/admin/backup/run）
 * 2. 备份历史（GET /api/admin/notifications/history 过滤 channelType=backup）
 * 3. 接收端配置导航（指向 /admin/notifications 页面新增 type=backup 通道）
 * 4. 保留策略（与通知配置共享，编辑入口在同一份 system:notifications 配置上）
 * 5. 调度说明（cron /api/cron/backup + 端点 + 鉴权）
 * 6. 最后一次执行结果摘要（来自最近一次 history / 内存中的 lastResult）
 *
 * 通道配置与通知共享同一份 system:notifications JSON 存储，不重复实现配置逻辑：
 * runBackupTask 直接读 notification 配置的 channels[].type === "backup" 项。
 * 因此本页面不重写配置表单，只提供导航与"立即执行"能力。
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { message, Switch as AntdSwitch } from "antd";
import {
  ChevronLeft,
  Database,
  History,
  Loader2,
  Play,
  RefreshCw,
  Send,
  Clock,
  Key,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import AdminLayout from "@/components/AdminLayout";
import { formatDateTime } from "@/lib/timezone";

interface BackupHistoryItem {
  id: string;
  channelId: string;
  channelName: string;
  channelType: string;
  title: string;
  status: string;
  httpStatus: number | null;
  error: string | null;
  sizeBytes: number;
  durationMs: number;
  sentAt: number;
}

interface BackupChannel {
  id: string;
  name: string;
  type: string;
  url: string;
  enabled: boolean;
  options: Record<string, string>;
}

interface RunResult {
  success: boolean;
  pushed: boolean;
  skipped?: string;
  pushedCount: number;
  failedCount: number;
  sizeBytes: number;
  durationMs: number;
}

export default function BackupCenterPage() {
  const { t } = useTranslation("backup");

  const [history, setHistory] = useState<BackupHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);

  const [running, setRunning] = useState(false);
  const [lastResult, setLastResult] = useState<RunResult | null>(null);
  const [lastRunAt, setLastRunAt] = useState<number | null>(null);

  // 接收端通道列表（来自通知配置中的 type=backup 项）
  const [channels, setChannels] = useState<BackupChannel[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(false);

  // ---------- 加载历史 ----------

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      // history API 暂未提供 channelType 过滤参数 —— 客户端过滤 backup 类型
      const res = await fetch("/api/admin/notifications/history?limit=200");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { success?: boolean; data?: BackupHistoryItem[] };
      const all = json?.data ?? [];
      setHistory(all.filter((h) => h.channelType === "backup"));
    } catch (err) {
      message.error(t("commonError", { error: err instanceof Error ? err.message : String(err) }));
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [t]);

  // ---------- 加载接收端通道 ----------

  const loadChannels = useCallback(async () => {
    setChannelsLoading(true);
    try {
      const res = await fetch("/api/admin/notifications");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        success?: boolean;
        data?: { channels?: BackupChannel[] };
      };
      const all = json?.data?.channels ?? [];
      setChannels(all.filter((c) => c.type === "backup"));
    } catch (err) {
      message.error(t("commonError", { error: err instanceof Error ? err.message : String(err) }));
      setChannels([]);
    } finally {
      setChannelsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    const t1 = setTimeout(loadHistory, 0);
    const t2 = setTimeout(loadChannels, 0);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [loadHistory, loadChannels]);

  // 自动刷新
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      void loadHistory();
    }, 10_000);
    return () => clearInterval(id);
  }, [autoRefresh, loadHistory]);

  // ---------- 立即执行 ----------

  const handleRunNow = async () => {
    setRunning(true);
    try {
      const res = await fetch("/api/admin/backup/run", { method: "POST" });
      const json = (await res.json().catch(() => null)) as
        | {
            success?: boolean;
            data?: RunResult;
            error?: { message?: string };
          }
        | null;
      if (!res.ok || !json) {
        throw new Error(json?.error?.message || `HTTP ${res.status}`);
      }
      if (!json.success) {
        // 任务本身执行但 skipped / failed
        const data = json.data;
        if (data?.skipped) {
          message.warning(t("runSkipped", { skipped: data.skipped }));
        } else {
          message.error(t("runFailed", { error: json.error?.message ?? t("runConfigMissing") }));
        }
        setLastResult(data ?? null);
        setLastRunAt(Math.floor(Date.now() / 1000));
        return;
      }
      const r = json.data;
      if (r) {
        setLastResult(r);
        setLastRunAt(Math.floor(Date.now() / 1000));
        if (r.success) {
          message.success(
            t("runSuccess", {
              pushedCount: r.pushedCount ?? 0,
              sizeBytes: r.sizeBytes ?? 0,
              durationMs: r.durationMs ?? 0,
            })
          );
        } else if (r.skipped) {
          message.warning(t("runSkipped", { skipped: r.skipped }));
        }
      }
      void loadHistory();
    } catch (err) {
      message.error(t("commonError", { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setRunning(false);
    }
  };

  // ---------- 派生 ----------

  const totalConfigured = channels.length;
  const totalEnabled = channels.filter((c) => c.enabled).length;
  const totalWithKey = channels.filter((c) => c.enabled && c.options.encryptionKey).length;

  return (
    <AdminLayout>
      <PageContainer>
        <PageHeader
          icon={<Database size={20} className="text-zinc-500 dark:text-zinc-400" />}
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
          {/* ========== 立即执行 + 摘要 ========== */}
          <ProCard>
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 mb-1">
                    {t("runNowTitle")}
                  </p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    {t("runNowDesc1")}
                    {t("runNowDesc2")}
                  </p>
                </div>
                <Button
                  variant="primary"
                  size="md"
                  onClick={handleRunNow}
                  loading={running}
                  icon={<Play className="w-4 h-4 mr-1" />}
                  disabled={running}
                >
                  {running ? t("running") : t("runNow")}
                </Button>
              </div>

              {/* 最近一次执行结果摘要 */}
              <div className="rounded-md bg-zinc-50 dark:bg-zinc-950/50 p-3 space-y-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <Clock className="w-3.5 h-3.5 text-zinc-400" />
                  <span className="text-zinc-500 dark:text-zinc-400">{t("lastRun")}:</span>
                  <span className="text-zinc-700 dark:text-zinc-300">
                    {lastRunAt ? formatDateTime(lastRunAt) : t("lastResultNone")}
                  </span>
                </div>
                {lastResult && (
                  <div className="flex items-start gap-2">
                    {lastResult.success ? (
                      <span className="text-emerald-600 dark:text-emerald-400 shrink-0">✓</span>
                    ) : (
                      <span className="text-red-600 dark:text-red-400 shrink-0">✗</span>
                    )}
                    <span className="text-zinc-700 dark:text-zinc-300">
                      {lastResult.success
                        ? t("lastResultSuccess", {
                            pushedCount: lastResult.pushedCount ?? 0,
                            totalCount: (lastResult.pushedCount ?? 0) + (lastResult.failedCount ?? 0),
                            sizeBytes: lastResult.sizeBytes ?? 0,
                            durationMs: lastResult.durationMs ?? 0,
                          })
                        : lastResult.skipped
                          ? t("lastResultSkipped", { skipped: lastResult.skipped })
                          : t("lastResultFailed", { skipped: t("runConfigMissing") })}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </ProCard>

          {/* ========== 接收端通道 ========== */}
          <ProCard
            title={
              <div className="flex items-center gap-2">
                <Key className="w-4 h-4 text-zinc-500" />
                <span>{t("configTitle")}</span>
              </div>
            }
            extra={
              <Link href="/admin/notifications">
                <Button variant="ghost" size="sm" icon={<ExternalLink className="w-3.5 h-3.5 mr-1" />}>
                  {t("openPage")}
                </Button>
              </Link>
            }
          >
            <div className="space-y-3">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">{t("configDesc")}</p>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">{t("statTotal")}</p>
                  <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
                    {totalConfigured}
                  </p>
                </div>
                <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">{t("statEnabled")}</p>
                  <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
                    {totalEnabled}
                  </p>
                </div>
                <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">{t("statWithKey")}</p>
                  <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
                    {totalWithKey}
                  </p>
                </div>
              </div>

              {channelsLoading ? (
                <div className="flex items-center justify-center py-4 text-zinc-400">
                  <Loader2 className="w-4 h-4 animate-spin" />
                </div>
              ) : channels.length === 0 ? (
                <p className="text-sm text-amber-600 dark:text-amber-400 py-2">
                  {t("runConfigMissing")} ·{" "}
                  <Link href="/admin/notifications" className="underline">
                    {t("goToNotifications")}
                  </Link>
                </p>
              ) : (
                <div className="space-y-1.5">
                  {channels.map((c) => (
                    <div
                      key={c.id}
                      className="flex flex-col sm:flex-row gap-2 sm:items-center px-3 py-2 rounded-md border border-zinc-200 dark:border-zinc-800 text-sm"
                    >
                      <span className="font-medium text-zinc-900 dark:text-zinc-100 sm:w-40 shrink-0">
                        {c.name || t("unnamed")}
                      </span>
                      <code className="text-xs text-zinc-500 dark:text-zinc-400 truncate flex-1 min-w-0">
                        {c.url}
                      </code>
                      <span
                        className={`text-xs shrink-0 ${
                          c.enabled
                            ? c.options.encryptionKey
                              ? "text-emerald-600 dark:text-emerald-400"
                              : "text-amber-600 dark:text-amber-400"
                            : "text-zinc-400 dark:text-zinc-500"
                        }`}
                      >
                        {c.enabled
                          ? c.options.encryptionKey
                            ? t("statusReady")
                            : t("statusMissingKey")
                          : t("statusDisabled")}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </ProCard>

          {/* ========== 调度说明 ========== */}
          <ProCard
            title={
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-zinc-500" />
                <span>{t("runInterval")}</span>
              </div>
            }
          >
            <div className="space-y-2 text-sm text-zinc-700 dark:text-zinc-300">
              <p>{t("schedIntro")}</p>
              <ul className="list-disc pl-5 space-y-1 text-xs text-zinc-500 dark:text-zinc-400">
                <li>
                  <strong>{t("schedCf")}</strong>
                  {t("schedCfDesc")}
                </li>
                <li>
                  <strong>{t("schedPages")}</strong>
                  {t("schedPagesDesc")}
                </li>
                <li>
                  <strong>{t("schedDocker")}</strong>
                  {t("schedDockerDesc")}
                </li>
                <li>
                  <strong>{t("schedAll")}</strong>
                  {t("cronAuth")}。
                </li>
              </ul>
              <div className="rounded-md bg-zinc-50 dark:bg-zinc-950/50 p-3 text-xs">
                <code className="block">
                  curl -X POST -H "Authorization: Bearer $CRON_SECRET" \<br />
                  &nbsp;&nbsp;https://your-domain.example.com/api/cron/backup
                </code>
              </div>
            </div>
          </ProCard>

          {/* ========== 备份历史 ========== */}
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
                  onClick={loadHistory}
                  loading={historyLoading}
                  icon={<RefreshCw className="w-3.5 h-3.5" />}
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
              <p className="text-sm text-zinc-400 py-4 text-center">
                {t("historyEmpty")}
                <br />
                <span className="text-xs">{t("historyHint")}</span>
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-800">
                    <tr>
                      <th className="text-left py-2 px-2">{t("fieldsTime")}</th>
                      <th className="text-left py-2 px-2">{t("fieldsChannel")}</th>
                      <th className="text-center py-2 px-2">{t("fieldsStatus")}</th>
                      <th className="text-right py-2 px-2">{t("fieldsSize")}</th>
                      <th className="text-right py-2 px-2">{t("fieldsDuration")}</th>
                      <th className="text-right py-2 px-2">{t("fieldsHttpStatus")}</th>
                      <th className="text-left py-2 px-2">{t("fieldsError")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h) => (
                      <tr key={h.id} className="border-b border-zinc-100 dark:border-zinc-800">
                        <td className="py-2 px-2 text-xs text-zinc-500 dark:text-zinc-400 whitespace-nowrap">
                          {formatDateTime(h.sentAt)}
                        </td>
                        <td className="py-2 px-2 text-zinc-900 dark:text-zinc-100">{h.channelName}</td>
                        <td className="py-2 px-2 text-center">
                          {h.status === "success" ? (
                            <span className="text-emerald-600 dark:text-emerald-400">
                              {t("statusSuccess")}
                            </span>
                          ) : (
                            <span className="text-red-600 dark:text-red-400">
                              {t("statusFailed")}
                            </span>
                          )}
                        </td>
                        <td className="py-2 px-2 text-right text-zinc-600 dark:text-zinc-300 text-xs">
                          {(h.sizeBytes / 1024).toFixed(1)} KB
                        </td>
                        <td className="py-2 px-2 text-right text-zinc-500 dark:text-zinc-400 text-xs">
                          {h.durationMs}ms
                        </td>
                        <td className="py-2 px-2 text-right text-zinc-500 dark:text-zinc-400 text-xs">
                          {h.httpStatus ?? "—"}
                        </td>
                        <td className="py-2 px-2 text-xs text-red-600 dark:text-red-400 max-w-[200px] truncate" title={h.error ?? ""}>
                          {h.error ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </ProCard>

          {/* ========== 跳转通知中心（备份通道编辑） ========== */}
          <ProCard bordered={false} className="bg-zinc-50 dark:bg-zinc-950/50">
            <div className="flex items-center justify-between gap-3">
              <div className="flex-1">
                <p className="text-sm text-zinc-700 dark:text-zinc-300">
                  {t("sharedConfigDesc")}
                </p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                  {t("addBackupChannelHint")}
                </p>
              </div>
              <Link href="/admin/notifications">
                <Button variant="secondary" size="sm" icon={<Send className="w-4 h-4 mr-1" />}>
                  {t("notificationsCenterLink")}
                </Button>
              </Link>
            </div>
          </ProCard>
        </div>
      </PageContainer>
    </AdminLayout>
  );
}
