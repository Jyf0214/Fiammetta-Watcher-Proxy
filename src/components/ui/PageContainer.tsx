import React from "react";
import { cn } from "@/lib/ui";

interface PageContainerProps {
  maxWidth?: "3xl" | "4xl" | "5xl" | "6xl" | "7xl";
  padding?: "default" | "compact" | "wide";
  children: React.ReactNode;
  className?: string;
}

const maxWidthMap: Record<string, string> = {
  "3xl": "max-w-3xl",
  "4xl": "max-w-4xl",
  "5xl": "max-w-5xl",
  "6xl": "max-w-6xl",
  "7xl": "max-w-7xl",
};

const paddingMap: Record<string, string> = {
  compact: "px-3 sm:px-6 py-6 sm:py-10",
  default: "px-3 sm:px-6 py-6 md:p-10",
  wide: "px-3 sm:px-6 py-12 md:py-20",
};

/**
 * 页面容器组件 — 约束内容宽度并提供统一的页面内边距
 * - 默认 max-w-4xl，内容紧凑
 * - 支持 compact/default/wide 三档内边距
 */
export function PageContainer({
  maxWidth = "6xl",
  padding = "default",
  children,
  className = "",
}: PageContainerProps) {
  return (
    <div
      className={cn(
        "flex-1 mx-auto w-full",
        maxWidthMap[maxWidth],
        paddingMap[padding],
        className
      )}
    >
      {children}
    </div>
  );
}
