import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Tag, Select, Tabs, DatePicker, Tooltip, message, type TableColumnsType } from "antd";
import type { Dayjs } from "dayjs";
import { Button } from "@/components/ui/Button";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import {
  RefreshCw,
  FileText,
  Search,
  Cloud,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { formatDateTime, formatDate } from "@/lib/timezone";
import { formatDuration } from "@/lib/format";
import { useApi, UNAUTHORIZED_MESSAGE } from "@/hooks/use-api";
import AdminLayout from "@/components/AdminLayout";

const { RangePicker } = DatePicker;

// ==================== 类型定义 ====================

interface LogEntry {
  id: string;
  model: string;
  status: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  ttft: number;
  duration: number;
  isError: boolean;
  errorMessage: string | null;
  createdAt: string;
  key: { name: string } | null;
  platform: { name: string } | null;
}

interface ArchiveEntry {
  id: string;
  date: string;
  keyId: string | null;
  keyName: string | null;
  platformId: string | null;
  platformName: string | null;
  model: string;
  totalRequests: number;
  errorRequests: number;
  totalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  avgTtft: number;
  avgDuration: number;
  avgTps: number;
  maxTtft: number;
  maxDuration: number;
  maxTps: number;
}

interface KeyOption {
  id: string;
  name: string;
}

// ==================== 详细日志 Tab ====================

function DetailedLogsTab({ onRefreshRef }: { onRefreshRef: (fn: () => void) => void }) {
  const { t } = useTranslation("log");
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [errorFilter, setErrorFilter] = useState<string>("");
  const [keyFilter, setKeyFilter] = useState<string | undefined>();
  const [dateRange, setDateRange] = useState<
    [Dayjs | null, Dayjs | null] | null
  >(null);

  // Key 选项：与归档 Tab 共享同一 SWR key（/api/admin/keys），自动去重为一次请求
  const { data: keyData } = useApi<{ id: string; name: string }[]>("/api/admin/keys");
  const keyOptions = useMemo<KeyOption[]>(
    () => (keyData ?? []).map((k) => ({ id: k.id, name: k.name })),
    [keyData]
  );

  // 日志列表：key 包含全部筛选参数，参数变化时 SWR 自动重新请求
  const logsKey = useMemo(() => {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: "20",
    });
    if (statusFilter) params.set("status", statusFilter);
    if (errorFilter) params.set("isError", errorFilter);
    if (keyFilter) params.set("keyId", keyFilter);
    if (dateRange && dateRange[0]) {
      params.set("startDate", dateRange[0].format("YYYY-MM-DD"));
    }
    if (dateRange && dateRange[1]) {
      params.set("endDate", dateRange[1].format("YYYY-MM-DD"));
    }
    return `/api/admin/logs?${params.toString()}`;
  }, [page, statusFilter, errorFilter, keyFilter, dateRange]);

  const { data, error, isValidating, mutate } = useApi<{
    items: LogEntry[];
    total: number;
  }>(logsKey);

  // 请求失败提示（401 已由 fetcher 统一提示并跳转登录页）
  useEffect(() => {
    if (error && error.message !== UNAUTHORIZED_MESSAGE) {
      message.error(t("common:error"));
    }
  }, [error, t]);

  const handleRefresh = useCallback(() => {
    mutate();
  }, [mutate]);

  useEffect(() => {
    onRefreshRef(handleRefresh);
  }, [onRefreshRef, handleRefresh]);

  const handleResetFilters = useCallback(() => {
    setStatusFilter(undefined);
    setErrorFilter("");
    setKeyFilter(undefined);
    setDateRange(null);
    setPage(1);
  }, []);

  const hasFilters = !!(statusFilter || errorFilter || keyFilter || dateRange);

  const columns: TableColumnsType<LogEntry> = [
    {
      title: t("common:createdAt"),
      dataIndex: "createdAt",
      key: "createdAt",
      width: 170,
      render: (v: string) => formatDateTime(v),
    },
    {
      title: t("apiKey"),
      key: "keyName",
      width: 130,
      ellipsis: true,
      render: (_: unknown, record: LogEntry) => record.key?.name || "-",
    },
    {
      title: t("platform"),
      key: "platformName",
      width: 110,
      ellipsis: true,
      render: (_: unknown, record: LogEntry) =>
        record.platform?.name || "-",
      responsive: ["md"],
    },
    {
      title: t("model"),
      dataIndex: "model",
      key: "model",
      width: 160,
      ellipsis: true,
    },
    {
      title: t("statusCode"),
      dataIndex: "status",
      key: "status",
      width: 80,
      align: "center",
      render: (v: number) => (
        <Tag
          color={
            v >= 200 && v < 300
              ? "green"
              : v === 429
                ? "gold"
                : v >= 500
                  ? "red"
                  : v >= 400
                    ? "orange"
                    : "default"
          }
        >
          {v}
        </Tag>
      ),
    },
    {
      title: t("errorMessage"),
      key: "errorMessage",
      width: 220,
      ellipsis: { showTitle: false },
      render: (_: unknown, record: LogEntry) =>
        record.isError && record.errorMessage ? (
          <Tooltip title={record.errorMessage}>
            <span className="text-red-500">{record.errorMessage}</span>
          </Tooltip>
        ) : "-",
    },
    {
      title: t("usage:promptTokens"),
      dataIndex: "promptTokens",
      key: "promptTokens",
      width: 100,
      align: "right",
      render: (v: number) => v?.toLocaleString() || "0",
    },
    {
      title: t("usage:completionTokens"),
      dataIndex: "completionTokens",
      key: "completionTokens",
      width: 100,
      align: "right",
      render: (v: number) => v?.toLocaleString() || "0",
    },
    {
      title: t("tokens"),
      dataIndex: "tokens",
      key: "tokens",
      width: 100,
      align: "right",
      render: (v: number) => v?.toLocaleString() || "0",
    },
    {
      title: t("ttft"),
      dataIndex: "ttft",
      key: "ttft",
      width: 90,
      align: "right",
      render: (v: number) => {
        if (v > 0) {
          const d = formatDuration(v, t);
          return `${d.value} ${d.suffix}`;
        }
        return t("na");
      },
    },
    {
      title: t("duration"),
      dataIndex: "duration",
      key: "duration",
      width: 90,
      align: "right",
      render: (v: number) => {
        if (v > 0) {
          const d = formatDuration(v, t);
          return `${d.value} ${d.suffix}`;
        }
        return "-";
      },
    },
  ];

  return (
    <>
      {/* 筛选栏 */}
      <div className="mb-4 grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-2">
        <RangePicker
          value={dateRange}
          onChange={(dates) => {
            setDateRange(dates as [Dayjs | null, Dayjs | null] | null);
            setPage(1);
          }}
          placeholder={[
            t("startDate"),
            t("endDate"),
          ]}
          className="w-full sm:w-[260px]"
        />
        <Select
          placeholder={t("filterByKey")}
          allowClear
          showSearch
          optionFilterProp="label"
          className="w-full sm:w-44"
          value={keyFilter}
          onChange={(v) => {
            setKeyFilter(v);
            setPage(1);
          }}
          options={keyOptions.map((k) => ({
            value: k.id,
            label: k.name,
          }))}
        />
        <Select
          placeholder={t("statusFilterPlaceholder")}
          allowClear
          className="w-full sm:w-32"
          value={statusFilter}
          onChange={(v) => {
            setStatusFilter(v);
            setPage(1);
          }}
          options={[
            { value: "200", label: "200" },
            { value: "400", label: "400" },
            { value: "401", label: "401" },
            { value: "429", label: "429" },
            { value: "500", label: "500" },
            { value: "503", label: "503" },
          ]}
        />
        <Select
          placeholder={t("errorFilterPlaceholder")}
          allowClear
          className="w-full sm:w-32"
          value={errorFilter || undefined}
          onChange={(v) => {
            setErrorFilter(v || "");
            setPage(1);
          }}
          options={[
            { value: "true", label: t("filterErrorOnly") },
            { value: "false", label: t("filterNormalOnly") },
          ]}
        />
        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            icon={<Search size={14} />}
            onClick={handleResetFilters}
          >
            {t("common:reset")}
          </Button>
        )}
      </div>

      <ResponsiveTable
        columns={columns}
        dataSource={data?.items ?? []}
        rowKey="id"
        loading={isValidating}
        pagination={{
          current: page,
          total: data?.total ?? 0,
          pageSize: 20,
          onChange: setPage,
          showTotal: (count) => t("common:pagination", { count }),
        }}
        scroll={{ x: 1300 }}
      />
    </>
  );
}

// ==================== 归档统计 Tab ====================

function ArchivedStatsTab({ onRefreshRef }: { onRefreshRef: (fn: () => void) => void }) {
  const { t } = useTranslation("log");
  const [page, setPage] = useState(1);
  const [dateRange, setDateRange] = useState<
    [Dayjs | null, Dayjs | null] | null
  >(null);
  const [keyFilter, setKeyFilter] = useState<string | undefined>();
  const [archiving, setArchiving] = useState(false);

  // Key 选项：与详细 Tab 共享同一 SWR key（/api/admin/keys），自动去重为一次请求
  const { data: keyData } = useApi<{ id: string; name: string }[]>("/api/admin/keys");
  const keyOptions = useMemo<KeyOption[]>(
    () => (keyData ?? []).map((k) => ({ id: k.id, name: k.name })),
    [keyData]
  );

  // 归档列表：key 包含全部筛选参数，参数变化时 SWR 自动重新请求
  const statsKey = useMemo(() => {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: "20",
    });
    if (keyFilter) params.set("keyId", keyFilter);
    if (dateRange && dateRange[0]) {
      params.set("startDate", dateRange[0].format("YYYY-MM-DD"));
    }
    if (dateRange && dateRange[1]) {
      params.set("endDate", dateRange[1].format("YYYY-MM-DD"));
    }
    return `/api/admin/logs/archive?${params.toString()}`;
  }, [page, keyFilter, dateRange]);

  const { data, error, isValidating, mutate } = useApi<{
    items: ArchiveEntry[];
    total: number;
  }>(statsKey);

  // 请求失败提示（401 已由 fetcher 统一提示并跳转登录页）
  useEffect(() => {
    if (error && error.message !== UNAUTHORIZED_MESSAGE) {
      message.error(t("fetchFailed"));
    }
  }, [error, t]);

  const handleRefresh = useCallback(() => {
    mutate();
  }, [mutate]);

  useEffect(() => {
    onRefreshRef(handleRefresh);
  }, [onRefreshRef, handleRefresh]);

  const handleManualArchive = useCallback(async () => {
    setArchiving(true);
    try {
      const res = await fetch("/api/admin/logs/archive", { method: "POST" });
      const data: any = await res.json();
      if (data.success) {
        message.success(data.message || t("archiveSuccess"));
        mutate();
      } else {
        message.error(data.error || t("archiveFailed"));
      }
    } catch {
      message.error(t("archiveRequestFailed"));
    } finally {
      setArchiving(false);
    }
  }, [mutate, t]);

  const columns: TableColumnsType<ArchiveEntry> = [
    {
      title: t("archiveDate"),
      dataIndex: "date",
      key: "date",
      width: 120,
      render: (v: string) => formatDate(v),
    },
    {
      title: t("apiKey"),
      key: "keyName",
      width: 130,
      ellipsis: true,
      render: (_: unknown, record: ArchiveEntry) =>
        record.keyName || "-",
    },
    {
      title: t("platform"),
      key: "platformName",
      width: 110,
      ellipsis: true,
      render: (_: unknown, record: ArchiveEntry) =>
        record.platformName || "-",
    },
    {
      title: t("model"),
      dataIndex: "model",
      key: "model",
      width: 160,
      ellipsis: true,
    },
    {
      title: t("totalRequests"),
      dataIndex: "totalRequests",
      key: "totalRequests",
      width: 90,
      align: "right",
      render: (v: number) => v?.toLocaleString() || "0",
    },
    {
      title: t("errorRequests"),
      dataIndex: "errorRequests",
      key: "errorRequests",
      width: 80,
      align: "right",
      render: (v: number) =>
        v > 0 ? (
          <span className="text-red-500">{v.toLocaleString()}</span>
        ) : (
          "0"
        ),
    },
    {
      title: t("usage:promptTokens"),
      dataIndex: "totalPromptTokens",
      key: "totalPromptTokens",
      width: 110,
      align: "right",
      render: (v: number) => v?.toLocaleString() || "0",
    },
    {
      title: t("usage:completionTokens"),
      dataIndex: "totalCompletionTokens",
      key: "totalCompletionTokens",
      width: 110,
      align: "right",
      render: (v: number) => v?.toLocaleString() || "0",
    },
    {
      title: t("tokens"),
      dataIndex: "totalTokens",
      key: "totalTokens",
      width: 100,
      align: "right",
      render: (v: number) => v?.toLocaleString() || "0",
    },
    {
      title: t("avgTtft"),
      dataIndex: "avgTtft",
      key: "avgTtft",
      width: 100,
      align: "right",
      render: (v: number) => {
        if (v > 0) {
          const d = formatDuration(Math.round(v), t);
          return `${d.value} ${d.suffix}`;
        }
        return "-";
      },
    },
    {
      title: t("avgDuration"),
      dataIndex: "avgDuration",
      key: "avgDuration",
      width: 100,
      align: "right",
      render: (v: number) => {
        if (v > 0) {
          const d = formatDuration(Math.round(v), t);
          return `${d.value} ${d.suffix}`;
        }
        return "-";
      },
    },
    {
      title: t("avgTps"),
      dataIndex: "avgTps",
      key: "avgTps",
      width: 90,
      align: "right",
      render: (v: number) => v > 0 ? v.toFixed(1) : "-",
    },
    {
      title: t("maxTps"),
      dataIndex: "maxTps",
      key: "maxTps",
      width: 90,
      align: "right",
      render: (v: number) => v > 0 ? v.toFixed(1) : "-",
    },
  ];

  return (
    <>
      {/* 筛选栏 */}
      <div className="mb-4 grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-2">
        <RangePicker
          value={dateRange}
          onChange={(dates) => {
            setDateRange(dates as [Dayjs | null, Dayjs | null] | null);
            setPage(1);
          }}
          placeholder={[
            t("startDate"),
            t("endDate"),
          ]}
          className="w-full sm:w-[260px]"
        />
        <Select
          placeholder={t("filterByKey")}
          allowClear
          showSearch
          optionFilterProp="label"
          className="w-full sm:w-44"
          value={keyFilter}
          onChange={(v) => {
            setKeyFilter(v);
            setPage(1);
          }}
          options={keyOptions.map((k) => ({
            value: k.id,
            label: k.name,
          }))}
        />
        {(keyFilter || dateRange) && (
          <Button
            variant="ghost"
            size="sm"
            icon={<Search size={14} />}
            onClick={() => {
              setKeyFilter(undefined);
              setDateRange(null);
              setPage(1);
            }}
          >
            {t("common:reset")}
          </Button>
        )}
        <Button
          variant="default"
          size="sm"
          icon={<Cloud size={14} />}
          onClick={handleManualArchive}
          disabled={archiving}
        >
          {archiving
            ? t("archiving")
            : t("manualArchive")}
        </Button>
      </div>

      <ResponsiveTable
        columns={columns}
        dataSource={data?.items ?? []}
        rowKey="id"
        loading={isValidating}
        pagination={{
          current: page,
          total: data?.total ?? 0,
          pageSize: 20,
          onChange: setPage,
          showTotal: (count) => t("common:pagination", { count }),
        }}
        scroll={{ x: 1500 }}
      />
    </>
  );
}

// ==================== 页面内容组件 ====================

function LogsContent() {
  const { t } = useTranslation("log");
  const detailRefreshRef = useRef<(() => void) | null>(null);
  const archiveRefreshRef = useRef<(() => void) | null>(null);
  const [activeTab, setActiveTab] = useState("detailed");

  const handleRefresh = useCallback(() => {
    if (activeTab === "detailed") {
      detailRefreshRef.current?.();
    } else {
      archiveRefreshRef.current?.();
    }
  }, [activeTab]);

  const tabItems = [
    {
      key: "detailed",
      label: t("tabDetailed"),
      children: (
        <DetailedLogsTab
          onRefreshRef={(fn) => { detailRefreshRef.current = fn; }}
        />
      ),
    },
    {
      key: "archived",
      label: t("tabArchived"),
      children: (
        <ArchivedStatsTab
          onRefreshRef={(fn) => { archiveRefreshRef.current = fn; }}
        />
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        icon={
          <FileText
            size={20}
            className="text-zinc-500 dark:text-zinc-400"
          />
        }
        title={t("admin:logs")}
        description={t("admin:logsDesc")}
        extra={
          <Button
            variant="default"
            onClick={handleRefresh}
            icon={<RefreshCw size={14} />}
          >
            {t("common:refresh")}
          </Button>
        }
      />

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={tabItems}
        size="large"
      />
    </PageContainer>
  );
}

// ==================== 带 AdminLayout 包装的页面 ====================

export default function LogsPage() {
  return (
    <AdminLayout>
      <LogsContent />
    </AdminLayout>
  );
}
