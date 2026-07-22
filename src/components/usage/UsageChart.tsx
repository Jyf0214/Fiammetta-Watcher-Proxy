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

/**
 * 格式化日期标签
 * - 按小时：YYYY-MM-DD HH:00 → HH:00
 * - 按天：YYYY-MM-DD → MM-DD
 */
function formatDateLabel(date: string, granularity: "hourly" | "daily"): string {
  if (granularity === "hourly") {
    // 格式：2024-01-15 14:00:00 → 14:00
    const timePart = date.slice(11, 16); // HH:MM
    return timePart || date.slice(11);
  }
  // 格式：2024-01-15 → 01-15
  return date.slice(5);
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

  return (
    <div className="h-[320px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={chartData}
          margin={{ top: 5, right: 20, left: 0, bottom: 5 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis
            dataKey="dateLabel"
            tick={{ fontSize: 12, fill: "#a1a1aa" }}
            tickLine={false}
            axisLine={{ stroke: "#e4e4e7" }}
          />
          <YAxis
            yAxisId="left"
            tick={{ fontSize: 12, fill: "#a1a1aa" }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) =>
              v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)
            }
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={{ fontSize: 12, fill: "#a1a1aa" }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) =>
              v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)
            }
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
