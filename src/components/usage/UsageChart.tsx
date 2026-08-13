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
import { formatCompact } from "@/lib/format";

interface TrendPoint {
  date: string;
  requests: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  tps: number;
}

interface UsageChartProps {
  data: TrendPoint[];
  /** 聚合粒度：hourly = 按小时，daily = 按天 */
  granularity?: "hourly" | "daily";
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

/** 自定义 tooltip — 跟随深色模式（recharts contentStyle 无法使用 Tailwind 类） */
function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-2 text-[13px] shadow-lg">
      <p className="text-zinc-500 dark:text-zinc-400 mb-1.5">{label}</p>
      <div className="space-y-1">
        {payload.map((item: any) => (
          <div key={item.dataKey} className="flex items-center gap-2 tabular-nums">
            <span
              className="inline-block w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: item.stroke || item.color }}
            />
            <span className="text-zinc-500 dark:text-zinc-400">{item.name}</span>
            <span className="font-semibold text-zinc-900 dark:text-zinc-100">
              {Number(item.value).toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function UsageChart({ data, granularity = "daily" }: UsageChartProps) {
  const { t } = useTranslation("usage");

  const chartData = useMemo(
    () =>
      data.map((d) => ({
        ...d,
        dateLabel: formatDateLabel(d.date, granularity),
      })),
    [data, granularity]
  );

  const { maxRequests, maxTokens, maxTps } = useMemo(() => {
    if (!chartData.length) return { maxRequests: 0, maxTokens: 0, maxTps: 0 };
    return {
      maxRequests: Math.max(...chartData.map((d) => d.requests)),
      maxTokens: Math.max(...chartData.map((d) => d.tokens)),
      maxTps: Math.max(...chartData.map((d) => d.tps)),
    };
  }, [chartData]);

  return (
    <div className="h-[220px] sm:h-[320px]">
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
            tickFormatter={(v: number) => formatCompact(v, t)}
            tickCount={calcNiceTicks(Math.max(maxRequests, maxTps), 0)}
            width={50}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={{ fontSize: 12, fill: "#a1a1aa" }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => formatCompact(v, t)}
            tickCount={calcNiceTicks(maxTokens, 0)}
            width={50}
          />
          <Tooltip content={<ChartTooltip />} />
          <Legend
            wrapperStyle={{ fontSize: "13px", paddingTop: "8px" }}
          />
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="requests"
            name={t("requests")}
            stroke="#3b82f6"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
          <Line
            yAxisId="right"
            type="monotone"
            dataKey="tokens"
            name={t("totalTokens")}
            stroke="#10b981"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="tps"
            name={t("tps")}
            stroke="#14b8a6"
            strokeWidth={2}
            strokeDasharray="4 2"
            dot={false}
            activeDot={{ r: 4 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
