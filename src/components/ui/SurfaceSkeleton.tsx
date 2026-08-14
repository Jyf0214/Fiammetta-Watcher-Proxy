"use client";

import { Skeleton } from "@/components/ui/Skeleton";

export type SurfaceSkeletonVariant = "list" | "form" | "grid" | "editor";

export interface SurfaceSkeletonProps {
  variant?: SurfaceSkeletonVariant;
  showHeader?: boolean;
  className?: string;
}

function HeaderSkeleton() {
  return (
    <div className="flex items-center justify-between h-11 mb-4">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-6 w-16 rounded-lg" />
    </div>
  );
}

function ListVariant() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 p-4 rounded-xl border border-zinc-200 dark:border-zinc-800">
          <Skeleton className="h-10 w-10 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
        </div>
      ))}
    </div>
  );
}

function FormVariant() {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-5">
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-1.5 pb-4 border-b border-zinc-100 dark:border-zinc-800/50 last:border-0 last:pb-0">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-3 w-32" />
          </div>
        ))}
      </div>
    </div>
  );
}

function GridVariant() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 space-y-2">
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </div>
  );
}

function EditorVariant() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-5 w-48" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-3 w-5/6" />
      <Skeleton className="h-40 w-full rounded-lg" />
    </div>
  );
}

const VARIANT_MAP: Record<SurfaceSkeletonVariant, () => React.ReactElement> = {
  list: ListVariant,
  form: FormVariant,
  grid: GridVariant,
  editor: EditorVariant,
};

/**
 * 通用表面骨架屏 — 4 种 variant 根据页面类型匹配
 *
 * - list: 卡片列表（头像 + 标题 + 副标题）
 * - form: 表单（标签 + 输入框 + 描述）
 * - grid: 网格卡片
 * - editor: 编辑器（标题 + 段落 + 大块）
 */
export function SurfaceSkeleton({
  variant = "list",
  showHeader = false,
  className = "",
}: SurfaceSkeletonProps) {
  const Content = VARIANT_MAP[variant] ?? ListVariant;
  return (
    <div className={className}>
      {showHeader && <HeaderSkeleton />}
      <Content />
    </div>
  );
}

export default SurfaceSkeleton;
