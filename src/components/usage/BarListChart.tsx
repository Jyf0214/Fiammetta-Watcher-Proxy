"use client";

import { useTranslation } from "react-i18next";
import { formatCompactNumber } from "@/lib/format";
import { cn } from "@/lib/ui";

export interface BarListItem {
  label: string;
  value: number;
  icon?: React.ReactNode;
}

export interface BarListChartProps {
  items: BarListItem[];
  title?: string;
  maxItems?: number;
  className?: string;
}

/**
 * 排行榜列表 — 纯 CSS 条形图，按 value 降序排列
 *
 * 每项含图标 + 标签 + 条形 + 数值，条形宽度按最大值比例计算
 */
export function BarListChart({
  items,
  title,
  maxItems = 5,
  className = "",
}: BarListChartProps) {
  const { t } = useTranslation("common");

  const sorted = [...items].sort((a, b) => b.value - a.value).slice(0, maxItems);
  const maxValue = Math.max(...sorted.map((i) => i.value), 1);

  if (sorted.length === 0) {
    return (
      <div className={cn("rounded-xl border border-zinc-200 dark:border-zinc-800 p-5", className)}>
        {title && <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3">{title}</h3>}
        <p className="text-sm text-zinc-400 dark:text-zinc-500 text-center py-8">{t("noData")}</p>
      </div>
    );
  }

  return (
    <div className={cn("rounded-xl border border-zinc-200 dark:border-zinc-800 p-5", className)}>
      {title && (
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3">{title}</h3>
      )}
      <div className="space-y-3">
        {sorted.map((item, idx) => (
          <div key={`${item.label}-${idx}`} className="flex items-center gap-3">
            {item.icon && <span className="shrink-0">{item.icon}</span>}
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-zinc-500 dark:text-zinc-400 truncate">{item.label}</span>
                <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 tabular-nums ml-2">
                  {formatCompactNumber(item.value, t)}
                </span>
              </div>
              <div className="h-1.5 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-zinc-400 dark:bg-zinc-500 rounded-full transition-all duration-300"
                  style={{ width: `${(item.value / maxValue) * 100}%` }}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default BarListChart;
