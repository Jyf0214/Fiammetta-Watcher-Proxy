import { type ReactNode, memo } from 'react';
import { cn } from '@/lib/ui';

/** 状态类型映射 */
export type StatusType = 'success' | 'warning' | 'error' | 'info';

const statusBgMap: Record<StatusType, string> = {
  success: 'bg-emerald-50 border-emerald-100',
  warning: 'bg-amber-50 border-amber-100',
  error: 'bg-red-50 border-red-100',
  info: 'bg-blue-50 border-blue-100',
};

const statusTextMap: Record<StatusType, string> = {
  success: 'text-emerald-700',
  warning: 'text-amber-700',
  error: 'text-red-700',
  info: 'text-blue-700',
};

const statusIconMap: Record<StatusType, string> = {
  success: 'text-emerald-500',
  warning: 'text-amber-500',
  error: 'text-red-500',
  info: 'text-blue-500',
};

export interface StatusCardProps {
  /** 状态图标 */
  icon: ReactNode;
  /** 状态标题 */
  title: string;
  /** 状态文本 */
  status: string;
  /** 状态类型，决定背景色 */
  statusType: StatusType;
  /** 自定义样式类名 */
  className?: string;
}

/**
 * 状态显示卡片 — 带背景色、图标、标题、状态文本
 */
export const StatusCard = memo<StatusCardProps>(({ icon, title, status, statusType, className }) => {
  return (
    <div className={cn('rounded-xl border p-4 flex items-center gap-3', statusBgMap[statusType], className)}>
      {/* 图标 */}
      <span className={cn('flex-shrink-0', statusIconMap[statusType])}>{icon}</span>
      {/* 标题与状态文本 */}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-zinc-900">{title}</div>
        <div className={cn('text-xs font-medium', statusTextMap[statusType])}>{status}</div>
      </div>
    </div>
  );
});

StatusCard.displayName = 'StatusCard';
export default StatusCard;
