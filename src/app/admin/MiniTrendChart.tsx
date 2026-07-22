"use client";

import { useMemo } from "react";
import { ResponsiveContainer, AreaChart, Area } from "recharts";

interface TrendPoint {
  date: string;
  value: number;
}

interface MiniTrendChartProps {
  data: TrendPoint[];
  color?: string;
  height?: number;
}

/**
 * 迷你趋势图组件
 * 用于仪表盘统计卡片的趋势展示，仅显示面积图，无坐标轴和标签
 */
export default function MiniTrendChart({
  data,
  color = "#3b82f6",
  height = 40,
}: MiniTrendChartProps) {
  const chartData = useMemo(
    () => data.map((d) => ({ value: d.value })),
    [data]
  );

  if (!data || data.length === 0) {
    return (
      <div
        className="w-full bg-zinc-50 dark:bg-zinc-800 rounded flex items-center justify-center"
        style={{ height }}
      >
        <span className="text-xs text-zinc-300">--</span>
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={chartData} margin={{ top: 2, right: 0, left: 0, bottom: 2 }}>
        <defs>
          <linearGradient id={`gradient-${color.replace("#", "")}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.3} />
            <stop offset="100%" stopColor={color} stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={1.5}
          fill={`url(#gradient-${color.replace("#", "")})`}
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
