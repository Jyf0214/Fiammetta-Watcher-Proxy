import { type ReactNode } from "react";
import { ProCard } from "./ProCard";
import { valueFontSize } from "@/lib/format";

export interface StatCardProps {
  /** 唯一标识 */
  key: string;
  /** 标题文字 */
  title: string;
  /** 主数值显示文本 */
  displayValue: string;
  /** 图标元素 */
  icon: ReactNode;
  /** 图标背景色（如 bg-blue-50） */
  iconBg?: string;
  /** 图标颜色（如 text-blue-500） */
  iconColor?: string;
  /** 右侧附加内容（如迷你趋势图） */
  extra?: ReactNode;
  /** 是否为详情模式（一行一个，带 extra） */
  detail?: boolean;
}

/**
 * 统计卡片组件 — 仪表盘数据卡片的统一实现
 *
 * 两种模式：
 * - grid（默认）：紧凑一行，图标+标题+数值
 * - detail：一行一个，图标+标题+数值+右侧趋势图
 */
export function StatCard({
  title,
  displayValue,
  icon,
  iconBg = "bg-blue-50",
  iconColor = "text-blue-500",
  extra,
  detail = false,
}: StatCardProps) {
  if (detail) {
    return (
      <ProCard className="bg-white border-zinc-200" padding="px-4 py-3">
        <div className="flex items-center gap-3">
          <div className={`h-8 w-8 ${iconBg} rounded-lg flex items-center justify-center shrink-0`}>
            <span className={`${iconColor} text-sm`}>{icon}</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-zinc-500 text-[11px] leading-tight mb-0.5">{title}</p>
            <p className={`${valueFontSize(displayValue)} font-bold text-zinc-900 tabular-nums leading-tight whitespace-nowrap`}>
              {displayValue}
            </p>
          </div>
          {extra && <div className="w-20 h-9 shrink-0">{extra}</div>}
        </div>
      </ProCard>
    );
  }

  return (
    <ProCard className="bg-white border-zinc-200" padding="p-3">
      <div className="flex items-center gap-2.5">
        <div className={`h-8 w-8 ${iconBg} rounded-lg flex items-center justify-center shrink-0`}>
          <span className={`${iconColor} text-sm`}>{icon}</span>
        </div>
        <div className="min-w-0">
          <p className="text-zinc-500 text-[11px] leading-tight truncate mb-0.5">{title}</p>
          <p className={`${valueFontSize(displayValue)} font-bold text-zinc-900 leading-tight tabular-nums whitespace-nowrap`}>
            {displayValue}
          </p>
        </div>
      </div>
    </ProCard>
  );
}
