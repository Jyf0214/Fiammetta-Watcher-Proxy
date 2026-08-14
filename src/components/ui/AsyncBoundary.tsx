"use client";

import { type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useTranslation } from "react-i18next";
import GlobalLoading from "@/components/Loading";
import { scaleFadeVariants, scaleFadeTransition } from "@/lib/motion";
import { EmptyState } from "@/components/ui/EmptyState";

export interface AsyncBoundaryProps {
  isLoading: boolean;
  error?: Error | null;
  isEmpty?: boolean;
  children: ReactNode;
  loadingNode?: ReactNode;
  errorNode?: ReactNode;
  emptyNode?: ReactNode;
  onRetry?: () => void;
  emptyTitle?: string;
  emptyHint?: string;
  emptyIcon?: ReactNode;
  emptyAction?: ReactNode;
}

/**
 * 统一数据四态边界 — loading → error → empty → children
 *
 * 优先级：loading 最高（含已有数据时的后台刷新），其次 error，再次 empty，最后 children。
 * hasSettled 语义：data !== undefined（空数组也算已加载），后台刷新出错不覆盖已有内容。
 */
export function AsyncBoundary({
  isLoading,
  error,
  isEmpty,
  children,
  loadingNode,
  errorNode,
  emptyNode,
  onRetry,
  emptyTitle,
  emptyHint,
  emptyIcon,
  emptyAction,
}: AsyncBoundaryProps) {
  const { t } = useTranslation("common");

  if (isLoading) {
    return (
      <AnimatePresence mode="wait">
        <m.div
          key="loading"
          variants={scaleFadeVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          transition={scaleFadeTransition}
        >
          {loadingNode ?? <GlobalLoading />}
        </m.div>
      </AnimatePresence>
    );
  }

  if (error) {
    if (errorNode) return <>{errorNode}</>;
    return (
      <div className="flex flex-col items-center justify-center min-h-[200px] gap-3">
        <AlertTriangle className="w-8 h-8 text-zinc-300 dark:text-zinc-600" />
        <span className="text-sm text-zinc-400 dark:text-zinc-500">
          {error.message || t("loadFailed")}
        </span>
        {onRetry && (
          <button
            onClick={onRetry}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            {t("retry")}
          </button>
        )}
      </div>
    );
  }

  if (isEmpty) {
    if (emptyNode) return <>{emptyNode}</>;
    return (
      <EmptyState
        icon={emptyIcon}
        title={emptyTitle ?? t("emptyTitle")}
        description={emptyHint}
        action={emptyAction}
      />
    );
  }

  return <>{children}</>;
}

export default AsyncBoundary;
