import React from "react";
import { cn } from "@/lib/ui";

interface PageHeaderProps {
  /** 标题图标 */
  icon: React.ReactNode;
  /** 标题文本 */
  title: string;
  /** 描述文本 */
  description?: React.ReactNode;
  /** 右侧操作区 */
  extra?: React.ReactNode;
  /** 底部间距，默认 mb-6 */
  className?: string;
}

/**
 * 页面标题区组件 — 统一的图标+标题+描述模式
 * - 图标带圆形背景
 * - 支持右侧操作按钮
 */
export function PageHeader({
  icon,
  title,
  description,
  extra,
  className = "mb-6",
}: PageHeaderProps) {
  return (
    <div className={cn("flex items-center justify-between", className)}>
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-100 dark:bg-zinc-800">
          {icon}
        </div>
        <div>
          <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">
            {title}
          </h1>
          {description && (
            <p className="text-zinc-500 dark:text-zinc-400 text-xs">
              {description}
            </p>
          )}
        </div>
      </div>
      {extra && <div className="flex items-center gap-2">{extra}</div>}
    </div>
  );
}
