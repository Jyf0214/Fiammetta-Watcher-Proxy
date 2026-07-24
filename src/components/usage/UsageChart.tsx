import { useMemo } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";

interface TrendPoint {
  date: string;
  requests: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
}

interface UsageChartProps {
  data: TrendPoint[];
  /** 聚合粒度：hourly = 按小时，daily = 按天 */
  granularity?: "hourly" | "daily";
}

/** 数字紧凑格式化：≥10亿 → B，≥100万 → M，≥1000 → K */
function formatCompact(v: number): string {
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

/**
 * 格式化日期标签
 * - 按小时：YYYY-MM-DD HH:00 → HH:00
 * - 按天：YYYY-MM-DD → MM-DD
 */
function formatDateLabel(date: string, granularity: "hourly" | "daily"): string {
  if (granularity === "hourly") {
    const timePart = date.slice(11, 16);
    return timePart || date.slice(11);
  }
  return date.slice(5);
}

/**
 * 根据数据范围计算合理的 Y 轴刻度数，避免重复标签
 */
function calcNiceTicks(max: number, min: number): number {
  const range = max - min;
  if (range <= 0) return 5;
  if (range <= 5) return range + 1;
  if (range <= 20) return 6;
  return 5;
}

export default function UsageChart({ data, granularity = "daily" }: UsageChartProps) {
  const { t } = useTranslation();

  const chartData = useMemo(
    () =>
      data.map((d) => ({
        ...d,
        dateLabel: formatDateLabel(d.date, granularity),
      })),
    [data, granularity]
  );

  const { maxRequests, maxTokens } = useMemo(() => {
    if (!chartData.length) return { maxRequests: 0, maxTokens: 0 };
    return {
      maxRequests: Math.max(...chartData.map((d) => d.requests)),
      maxTokens: Math.max(...chartData.map((d) => d.tokens)),
    };
  }, [chartData]);

  return (
    <div className="h-[320px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={chartData}
          margin={{ top: 5, right: 20, left: 10, bottom: 5 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis
            dataKey="dateLabel"
            tick={{ fontSize: 12, fill: "#a1a1aa" }}
            tickLine={false}
            axisLine={{ stroke: "#e4e4e7" }}
            interval="preserveStartEnd"
          />
          <YAxis
            yAxisId="left"
            tick={{ fontSize: 12, fill: "#a1a1aa" }}
            tickLine={false}
            axisLine={false}
            tickFormatter={formatCompact}
            tickCount={calcNiceTicks(maxRequests, 0)}
            width={50}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={{ fontSize: 12, fill: "#a1a1aa" }}
            tickLine={false}
            axisLine={false}
            tickFormatter={formatCompact}
            tickCount={calcNiceTicks(maxTokens, 0)}
            width={50}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "#fff",
              border: "1px solid #e4e4e7",
              borderRadius: "8px",
              fontSize: "13px",
              boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
            }}
            formatter={(value, name) => [
              Number(value).toLocaleString(),
              String(name),
            ]}
            labelFormatter={(label) => String(label)}
          />
          <Legend
            wrapperStyle={{ fontSize: "13px", paddingTop: "8px" }}
          />
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="requests"
            name={t("usage.requests")}
            stroke="#3b82f6"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
          <Line
            yAxisId="right"
            type="monotone"
            dataKey="tokens"
            name={t("usage.total_tokens")}
            stroke="#10b981"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
