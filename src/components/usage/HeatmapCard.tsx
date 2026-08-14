"use client";

import { useTranslation } from "react-i18next";
import { ProCard } from "@/components/ui/ProCard";
import { Activity } from "@/components/ui/Activity";
import { cn } from "@/lib/ui";

export interface HeatmapStats {
  peakTokens?: number;
  peakDuration?: number;
  currentStreak?: number;
  longestStreak?: number;
}

export interface HeatmapCardProps {
  stats: HeatmapStats;
  isLoading?: boolean;
  className?: string;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

function StatItem({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex flex-col items-center gap-1 flex-1">
      <span className="text-xl font-bold text-zinc-900 dark:text-zinc-100 tabular-nums">
        {value ?? "—"}
      </span>
      <span className="text-xs text-zinc-400 dark:text-zinc-500">{label}</span>
    </div>
  );
}

function Divider() {
  return <div className="w-px h-8 bg-zinc-200 dark:bg-zinc-700" />;
}

/**
 * 活动热力统计卡片 — 峰值 Token / 最长任务 / 连续天数
 *
 * 使用 Activity 保活：loading 时保持已有数据不卸载
 */
export function HeatmapCard({ stats, isLoading, className = "" }: HeatmapCardProps) {
  const { t } = useTranslation("usage");

  const items: Array<{ label: string; value?: string }> = [
    { label: t("peakTokens"), value: stats.peakTokens != null ? String(stats.peakTokens) : undefined },
    { label: t("peakDuration"), value: stats.peakDuration != null ? formatDuration(stats.peakDuration) : undefined },
    { label: t("currentStreak"), value: stats.currentStreak != null ? `${stats.currentStreak}` : undefined },
    { label: t("longestStreak"), value: stats.longestStreak != null ? `${stats.longestStreak}` : undefined },
  ];

  return (
    <ProCard className={cn(className)} padding="p-5">
      <Activity active={!isLoading}>
        <div className="flex items-center justify-between">
          {items.map((item, idx) => (
            <div key={idx} className="flex items-center flex-1">
              {idx > 0 && <Divider />}
              <StatItem label={item.label} value={item.value} />
            </div>
          ))}
        </div>
      </Activity>
    </ProCard>
  );
}

export default HeatmapCard;
