"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Tag,
  Select,
  DatePicker,
  message,
  type TableColumnsType,
} from "antd";
import type { Dayjs } from "dayjs";
import { Button } from "@/components/ui/Button";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import {
  ReloadOutlined,
  FileTextOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import GlobalLoading from "@/components/Loading";

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

interface KeyOption {
  id: string;
  name: string;
}

// ==================== 页面组件 ====================

export default function LogsPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [errorFilter, setErrorFilter] = useState<string>("");
  const [keyFilter, setKeyFilter] = useState<string | undefined>();
  const [dateRange, setDateRange] = useState<
    [Dayjs | null, Dayjs | null] | null
  >(null);
  const [keyOptions, setKeyOptions] = useState<KeyOption[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  // 加载 API Key 列表（用于筛选下拉）
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/admin/keys", { signal: controller.signal })
      .then((res) => res.json())
      .then((data) => {
        if (data.success && Array.isArray(data.data)) {
          setKeyOptions(
            data.data.map((k: { id: string; name: string }) => ({
              id: k.id,
              name: k.name,
            }))
          );
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  // 获取日志数据
  useEffect(() => {
    const controller = new AbortController();

    const fetchLogs = async () => {
      setLoading(true);
      try {
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

        const res = await fetch(`/api/admin/logs?${params}`, {
          signal: controller.signal,
        });
        if (res.status === 401) {
          message.warning(
            t("auth.unauthorized") || "登录已过期，请重新登录"
          );
          router.push("/admin/login");
          return;
        }
        const data = await res.json();
        if (data.success) {
          if (data.data?.items) setLogs(data.data.items);
          if (data.data) setTotal(data.data.total);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        message.error(t("common.error"));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };

    fetchLogs();
    return () => controller.abort();
  }, [
    page,
    statusFilter,
    errorFilter,
    keyFilter,
    dateRange,
    router,
    t,
    refreshKey,
  ]);

  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  // 重置所有筛选
  const handleResetFilters = useCallback(() => {
    setStatusFilter(undefined);
    setErrorFilter("");
    setKeyFilter(undefined);
    setDateRange(null);
    setPage(1);
  }, []);

  // ==================== 表格列 ====================

  const columns: TableColumnsType<LogEntry> = [
    {
      title: t("common.created_at"),
      dataIndex: "createdAt",
      key: "createdAt",
      width: 170,
      render: (v: string) => new Date(v).toLocaleString(),
    },
    {
      title: t("log.api_key"),
      key: "keyName",
      width: 130,
      ellipsis: true,
      render: (_: unknown, record: LogEntry) => record.key?.name || "-",
    },
    {
      title: t("log.platform"),
      key: "platformName",
      width: 110,
      ellipsis: true,
      render: (_: unknown, record: LogEntry) =>
        record.platform?.name || "-",
      responsive: ["md"],
    },
    {
      title: t("log.model"),
      dataIndex: "model",
      key: "model",
      width: 160,
      ellipsis: true,
    },
    {
      title: t("log.status_code"),
      dataIndex: "status",
      key: "status",
      width: 80,
      align: "center",
      render: (v: number) => (
        <Tag
          color={
            v >= 200 && v < 300
              ? "green"
              : v >= 400
                ? "red"
                : "orange"
          }
        >
          {v}
        </Tag>
      ),
    },
    {
      title: t("usage.prompt_tokens"),
      dataIndex: "promptTokens",
      key: "promptTokens",
      width: 90,
      align: "right",
      render: (v: number) => v?.toLocaleString() || "0",
      responsive: ["sm"],
    },
    {
      title: t("usage.completion_tokens"),
      dataIndex: "completionTokens",
      key: "completionTokens",
      width: 90,
      align: "right",
      render: (v: number) => v?.toLocaleString() || "0",
      responsive: ["sm"],
    },
    {
      title: t("log.tokens"),
      dataIndex: "tokens",
      key: "tokens",
      width: 90,
      align: "right",
      render: (v: number) => v?.toLocaleString() || "0",
      responsive: ["md"],
    },
    {
      title: t("log.ttft"),
      dataIndex: "ttft",
      key: "ttft",
      width: 85,
      align: "right",
      render: (v: number) => (v > 0 ? `${v}ms` : "-"),
      responsive: ["md"],
    },
    {
      title: t("log.duration"),
      dataIndex: "duration",
      key: "duration",
      width: 85,
      align: "right",
      render: (v: number) => (v > 0 ? `${v}ms` : "-"),
      responsive: ["lg"],
    },
    {
      title: t("log.is_error"),
      dataIndex: "isError",
      key: "isError",
      width: 80,
      align: "center",
      render: (v: boolean) =>
        v ? (
          <Tag color="red">{t("common.error")}</Tag>
        ) : (
          <Tag color="green">{t("common.success")}</Tag>
        ),
      responsive: ["lg"],
    },
  ];

  if (loading && logs.length === 0) {
    return <GlobalLoading size="large" />;
  }

  return (
    <PageContainer>
      <PageHeader
        icon={
          <FileTextOutlined
            size={20}
            className="text-zinc-500 dark:text-zinc-400"
          />
        }
        title={t("admin.logs")}
        description={t("admin.logs_desc")}
        extra={
          <Button
            variant="default"
            icon={<ReloadOutlined />}
            onClick={handleRefresh}
            disabled={loading}
          >
            {t("common.refresh")}
          </Button>
        }
      />

      <ProCard>
        {/* 筛选栏 */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <RangePicker
            value={dateRange}
            onChange={(dates) => {
              setDateRange(dates as [Dayjs | null, Dayjs | null] | null);
              setPage(1);
            }}
            placeholder={[
              t("log.start_date") || "开始日期",
              t("log.end_date") || "结束日期",
            ]}
            className="w-[260px]"
          />
          <Select
            placeholder={t("log.filter_by_key") || "按 Key 筛选"}
            allowClear
            showSearch
            optionFilterProp="label"
            className="w-44"
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
            placeholder={t("log.status_filter_placeholder")}
            allowClear
            className="w-32"
            value={statusFilter}
            onChange={(v) => {
              setStatusFilter(v);
              setPage(1);
            }}
          >
            <Select.Option value="200">200</Select.Option>
            <Select.Option value="400">400</Select.Option>
            <Select.Option value="401">401</Select.Option>
            <Select.Option value="429">429</Select.Option>
            <Select.Option value="500">500</Select.Option>
            <Select.Option value="503">503</Select.Option>
          </Select>
          <Select
            placeholder={t("log.error_filter_placeholder")}
            allowClear
            className="w-32"
            value={errorFilter || undefined}
            onChange={(v) => {
              setErrorFilter(v || "");
              setPage(1);
            }}
          >
            <Select.Option value="true">
              {t("log.filter_error_only")}
            </Select.Option>
            <Select.Option value="false">
              {t("log.filter_normal_only")}
            </Select.Option>
          </Select>
          {(statusFilter || errorFilter || keyFilter || dateRange) && (
            <Button
              variant="ghost"
              size="sm"
              icon={<SearchOutlined />}
              onClick={handleResetFilters}
            >
              {t("common.reset") || "重置"}
            </Button>
          )}
        </div>

        {/* 日志表格 */}
        <ResponsiveTable
          columns={columns}
          dataSource={logs}
          rowKey="id"
          loading={loading}
          pagination={{
            current: page,
            total,
            pageSize: 20,
            onChange: setPage,
            showTotal: (count) =>
              t("common.pagination_total", { count }),
          }}
          scroll={{ x: 1100 }}
        />
      </ProCard>
    </PageContainer>
  );
}
