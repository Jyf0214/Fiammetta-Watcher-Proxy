/**
 * 请求日志页面
 *
 * 功能：
 * - 详细日志 Tab：请求日志列表，支持分页、按 Key/状态/错误/日期范围筛选
 * - 归档统计 Tab：归档统计数据，支持分页、按 Key/日期范围筛选、手动触发归档
 *
 * 主分支对应文件：src/app/admin/logs/page.tsx
 * 迁移变更：
 * - @lobehub/ui → Ant Design 5 原生组件
 * - 自定义组件（ResponsiveTable/PageContainer/PageHeader/ProCard）→ Ant Design 标准组件
 * - react-i18next → 中文直接写死
 * - useRouter from next/navigation → next/router（Pages Router）
 * - src/app/admin/logs/page.tsx → pages/admin/logs.tsx
 */

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";
import {
  Table,
  Tag,
  Select,
  DatePicker,
  Tabs,
  Button,
  Card,
  Space,
  message,
  Typography,
  Spin,
} from "antd";
import type { TableColumnsType } from "antd";
import dayjs from "dayjs";

const { RangePicker } = DatePicker;
const { Title, Text } = Typography;

// ==================== 类型定义 ====================

/** 详细日志条目 */
interface LogEntry {
  id: string;
  model: string;
  status: number;
  tokensTotal: number;
  tokensPrompt: number;
  tokensCompletion: number;
  latency: number;
  errorMessage: string | null;
  createdAt: number; // Unix 时间戳（秒）
  apiKeyName: string | null;
  platformId: string | null;
}

/** 归档统计条目 */
interface ArchiveEntry {
  id: string;
  date: string;
  keyName: string | null;
  platformName: string | null;
  model: string;
  totalRequests: number;
  errorRequests: number;
  totalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  avgLatency: number;
}

/** Key 选项（用于筛选下拉框） */
interface KeyOption {
  id: string;
  name: string;
}

// ==================== 详细日志 Tab ====================

function DetailedLogsTab() {
  const router = useRouter();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [errorFilter, setErrorFilter] = useState<string | undefined>();
  const [keyFilter, setKeyFilter] = useState<string | undefined>();
  const [dateRange, setDateRange] = useState<[dayjs.Dayjs | null, dayjs.Dayjs | null] | null>(null);
  const [keyOptions, setKeyOptions] = useState<KeyOption[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  // 加载 Key 列表（用于筛选下拉框）
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/admin/keys", { signal: controller.signal })
      .then((res) => res.json() as any)
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

  // 加载日志数据
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
          message.warning("登录已过期，请重新登录");
          router.push("/admin/login");
          return;
        }
        const data: any = await res.json();
        if (data.success) {
          if (data.data?.items) setLogs(data.data.items);
          if (data.data) setTotal(data.data.total);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        message.error("获取日志失败");
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };

    fetchLogs();
    return () => controller.abort();
  }, [page, statusFilter, errorFilter, keyFilter, dateRange, router, refreshKey]);

  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const handleResetFilters = useCallback(() => {
    setStatusFilter(undefined);
    setErrorFilter(undefined);
    setKeyFilter(undefined);
    setDateRange(null);
    setPage(1);
  }, []);

  /** 格式化 Unix 时间戳为本地时间字符串 */
  const formatTime = (ts: number) => {
    return new Date(ts * 1000).toLocaleString("zh-CN");
  };

  const columns: TableColumnsType<LogEntry> = [
    {
      title: "时间",
      dataIndex: "createdAt",
      key: "createdAt",
      width: 170,
      render: (v: number) => formatTime(v),
    },
    {
      title: "Key 名称",
      dataIndex: "apiKeyName",
      key: "apiKeyName",
      width: 130,
      ellipsis: true,
      render: (v: string | null) => v || "-",
    },
    {
      title: "模型",
      dataIndex: "model",
      key: "model",
      width: 160,
      ellipsis: true,
    },
    {
      title: "状态码",
      dataIndex: "status",
      key: "status",
      width: 80,
      align: "center",
      render: (v: number) => (
        <Tag color={v >= 200 && v < 300 ? "green" : v >= 400 ? "red" : "orange"}>
          {v}
        </Tag>
      ),
    },
    {
      title: "Prompt",
      dataIndex: "tokensPrompt",
      key: "tokensPrompt",
      width: 100,
      align: "right",
      render: (v: number) => v?.toLocaleString() || "0",
    },
    {
      title: "Completion",
      dataIndex: "tokensCompletion",
      key: "tokensCompletion",
      width: 100,
      align: "right",
      render: (v: number) => v?.toLocaleString() || "0",
    },
    {
      title: "总 Token",
      dataIndex: "tokensTotal",
      key: "tokensTotal",
      width: 100,
      align: "right",
      render: (v: number) => v?.toLocaleString() || "0",
    },
    {
      title: "延迟",
      dataIndex: "latency",
      key: "latency",
      width: 90,
      align: "right",
      render: (v: number) => (v > 0 ? `${v}ms` : "-"),
    },
    {
      title: "错误",
      dataIndex: "errorMessage",
      key: "errorMessage",
      width: 80,
      align: "center",
      render: (v: string | null) =>
        v ? <Tag color="red">错误</Tag> : <Tag color="green">成功</Tag>,
    },
  ];

  const hasFilters = statusFilter || errorFilter || keyFilter || dateRange;

  return (
    <>
      {/* 筛选栏 */}
      <Space wrap style={{ marginBottom: 16 }}>
        <RangePicker
          value={dateRange as [dayjs.Dayjs, dayjs.Dayjs] | null}
          onChange={(dates) => {
            setDateRange(dates as [dayjs.Dayjs | null, dayjs.Dayjs | null] | null);
            setPage(1);
          }}
          placeholder={["开始日期", "结束日期"]}
          style={{ width: 260 }}
        />
        <Select
          placeholder="按 Key 筛选"
          allowClear
          showSearch
          optionFilterProp="label"
          style={{ width: 180 }}
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
          placeholder="按状态筛选"
          allowClear
          style={{ width: 140 }}
          value={statusFilter}
          onChange={(v) => {
            setStatusFilter(v);
            setPage(1);
          }}
          options={[
            { value: "2xx", label: "2xx 成功" },
            { value: "4xx", label: "4xx 客户端错误" },
            { value: "5xx", label: "5xx 服务端错误" },
          ]}
        />
        <Select
          placeholder="错误筛选"
          allowClear
          style={{ width: 130 }}
          value={errorFilter}
          onChange={(v) => {
            setErrorFilter(v);
            setPage(1);
          }}
          options={[
            { value: "true", label: "仅错误" },
            { value: "false", label: "仅正常" },
          ]}
        />
        {hasFilters && (
          <Button type="link" onClick={handleResetFilters}>
            重置
          </Button>
        )}
        <Button onClick={handleRefresh} loading={loading}>
          刷新
        </Button>
      </Space>

      <Table<LogEntry>
        columns={columns}
        dataSource={logs}
        rowKey="id"
        loading={loading}
        pagination={{
          current: page,
          total,
          pageSize: 20,
          onChange: setPage,
          showTotal: (count) => `共 ${count} 条`,
        }}
        scroll={{ x: 1200 }}
        size="small"
      />
    </>
  );
}

// ==================== 归档统计 Tab ====================

function ArchivedStatsTab() {
  const router = useRouter();
  const [stats, setStats] = useState<ArchiveEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [dateRange, setDateRange] = useState<[dayjs.Dayjs | null, dayjs.Dayjs | null] | null>(null);
  const [keyOptions, setKeyOptions] = useState<KeyOption[]>([]);
  const [keyFilter, setKeyFilter] = useState<string | undefined>();
  const [archiving, setArchiving] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // 加载 Key 列表
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/admin/keys", { signal: controller.signal })
      .then((res) => res.json() as any)
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

  // 加载归档数据
  useEffect(() => {
    const controller = new AbortController();

    const fetchStats = async () => {
      setLoading(true);
      try {
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

        const res = await fetch(`/api/admin/logs/archive?${params}`, {
          signal: controller.signal,
        });
        if (res.status === 401) {
          message.warning("登录已过期，请重新登录");
          router.push("/admin/login");
          return;
        }
        const data: any = await res.json();
        if (data.success) {
          if (data.data?.items) setStats(data.data.items);
          if (data.data) setTotal(data.data.total);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        message.error("获取归档数据失败");
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };

    fetchStats();
    return () => controller.abort();
  }, [page, keyFilter, dateRange, router, refreshKey]);

  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  /** 手动触发日志归档 */
  const handleManualArchive = useCallback(async () => {
    setArchiving(true);
    try {
      const res = await fetch("/api/admin/logs/archive", { method: "POST" });
      const data: any = await res.json();
      if (data.success) {
        message.success(data.message || "归档完成");
        handleRefresh();
      } else {
        message.error(data.error || "归档失败");
      }
    } catch {
      message.error("归档请求失败");
    } finally {
      setArchiving(false);
    }
  }, [handleRefresh]);

  const columns: TableColumnsType<ArchiveEntry> = [
    {
      title: "日期",
      dataIndex: "date",
      key: "date",
      width: 120,
      render: (v: string) => new Date(v).toLocaleDateString("zh-CN"),
    },
    {
      title: "Key 名称",
      dataIndex: "keyName",
      key: "keyName",
      width: 130,
      ellipsis: true,
      render: (v: string | null) => v || "-",
    },
    {
      title: "模型",
      dataIndex: "model",
      key: "model",
      width: 160,
      ellipsis: true,
    },
    {
      title: "总请求",
      dataIndex: "totalRequests",
      key: "totalRequests",
      width: 90,
      align: "right",
      render: (v: number) => v?.toLocaleString() || "0",
    },
    {
      title: "错误数",
      dataIndex: "errorRequests",
      key: "errorRequests",
      width: 80,
      align: "right",
      render: (v: number) =>
        v > 0 ? <Tag color="red">{v.toLocaleString()}</Tag> : "0",
    },
    {
      title: "Prompt Token",
      dataIndex: "totalPromptTokens",
      key: "totalPromptTokens",
      width: 110,
      align: "right",
      render: (v: number) => v?.toLocaleString() || "0",
    },
    {
      title: "Completion Token",
      dataIndex: "totalCompletionTokens",
      key: "totalCompletionTokens",
      width: 110,
      align: "right",
      render: (v: number) => v?.toLocaleString() || "0",
    },
    {
      title: "总 Token",
      dataIndex: "totalTokens",
      key: "totalTokens",
      width: 100,
      align: "right",
      render: (v: number) => v?.toLocaleString() || "0",
    },
    {
      title: "平均延迟",
      dataIndex: "avgLatency",
      key: "avgLatency",
      width: 100,
      align: "right",
      render: (v: number) => (v > 0 ? `${Math.round(v)}ms` : "-"),
    },
  ];

  return (
    <>
      {/* 筛选栏 */}
      <Space wrap style={{ marginBottom: 16 }}>
        <RangePicker
          value={dateRange as [dayjs.Dayjs, dayjs.Dayjs] | null}
          onChange={(dates) => {
            setDateRange(dates as [dayjs.Dayjs | null, dayjs.Dayjs | null] | null);
            setPage(1);
          }}
          placeholder={["开始日期", "结束日期"]}
          style={{ width: 260 }}
        />
        <Select
          placeholder="按 Key 筛选"
          allowClear
          showSearch
          optionFilterProp="label"
          style={{ width: 180 }}
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
        {keyFilter || dateRange ? (
          <Button
            type="link"
            onClick={() => {
              setKeyFilter(undefined);
              setDateRange(null);
              setPage(1);
            }}
          >
            重置
          </Button>
        ) : null}
        <Button onClick={handleRefresh} loading={loading}>
          刷新
        </Button>
        <Button type="primary" onClick={handleManualArchive} loading={archiving}>
          {archiving ? "归档中..." : "立即归档"}
        </Button>
      </Space>

      <Table<ArchiveEntry>
        columns={columns}
        dataSource={stats}
        rowKey="id"
        loading={loading}
        pagination={{
          current: page,
          total,
          pageSize: 20,
          onChange: setPage,
          showTotal: (count) => `共 ${count} 条`,
        }}
        scroll={{ x: 1200 }}
        size="small"
      />
    </>
  );
}

// ==================== 页面组件 ====================

export default function LogsPage() {
  const tabItems = [
    {
      key: "detailed",
      label: "详细日志",
      children: <DetailedLogsTab />,
    },
    {
      key: "archived",
      label: "归档统计",
      children: <ArchivedStatsTab />,
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Space align="center" style={{ marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>
          📋 请求日志
        </Title>
        <Text type="secondary">查看请求详情和归档统计</Text>
      </Space>

      <Card>
        <Tabs defaultActiveKey="detailed" items={tabItems} size="large" />
      </Card>
    </div>
  );
}
