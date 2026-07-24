"use client";

import { useMemo } from "react";
import { ResponsiveContainer, AreaChart, Area, ReferenceLine } from "recharts";

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
 *
 * 降级策略：
 * - 0 个数据点 → 不渲染图表（由父组件控制空状态）
 * - 1 个数据点 → 渲染水平基准线
 * - ≥2 个数据点 → 正常面积图
 */
export default function MiniTrendChart({
  data,
  color = "#3b82f6",
  height = 36,
}: MiniTrendChartProps) {
  const chartData = useMemo(
    () => data.map((d) => ({ value: d.value })),
    [data]
  );

  if (!data || data.length === 0) return null;

  // 单点降级：渲染水平虚线
  if (data.length === 1) {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <div className="w-full flex items-center gap-1.5 px-1">
          <div className="flex-1 h-px border-t border-dashed" style={{ borderColor: color, opacity: 0.4 }} />
          <span className="text-[10px] tabular-nums shrink-0" style={{ color }}>
            {data[0].value.toLocaleString()}
          </span>
        </div>
      </div>
    );
  }

  // 计算 Y 轴范围，留 10% padding 避免贴顶
  const values = chartData.map((d) => d.value);
  const maxVal = Math.max(...values);
  const minVal = Math.min(...values);
  const padding = Math.max((maxVal - minVal) * 0.1, maxVal * 0.05);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart
        data={chartData}
        margin={{ top: 4, right: 0, left: 0, bottom: 4 }}
      >
        <defs>
          <linearGradient id={`gradient-${color.replace("#", "")}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.25} />
            <stop offset="100%" stopColor={color} stopOpacity={0.03} />
          </linearGradient>
        </defs>
        {minVal > 0 && (
          <ReferenceLine y={minVal} stroke={color} strokeDasharray="2 4" strokeOpacity={0.2} />
        )}
        <Area
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={1.5}
          fill={`url(#gradient-${color.replace("#", "")})`}
          dot={false}
          isAnimationActive={false}
          // 留 Y 轴空间，避免点贴顶/贴底
          baseValue={Math.max(0, minVal - padding)}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
