import { cn } from '@/lib/ui';

export interface SkeletonProps {
  className?: string;
}

/**
 * 通用骨架屏占位组件，使用 Tailwind animate-pulse 动画
 */
export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={cn('bg-zinc-200 dark:bg-zinc-700 rounded animate-pulse', className)}
      aria-hidden="true"
    />
  );
}
