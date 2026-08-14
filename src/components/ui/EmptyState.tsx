"use client";

import { type ReactNode } from "react";
import { Inbox } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useTranslation } from "react-i18next";
import { scaleFadeVariants, scaleFadeTransition } from "@/lib/motion";

export interface EmptyStateProps {
  icon?: ReactNode;
  title?: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

/**
 * 统一空状态组件 — 大图标 + 标题 + 描述 + 可选操作按钮
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className = "",
}: EmptyStateProps) {
  const { t } = useTranslation("common");

  return (
    <AnimatePresence mode="wait">
      <m.div
        variants={scaleFadeVariants}
        initial="initial"
        animate="animate"
        exit="exit"
        transition={scaleFadeTransition}
        className={`flex flex-col items-center justify-center text-center py-12 gap-3 ${className}`}
      >
        <div className="opacity-30 text-zinc-400 dark:text-zinc-500">
          {icon ?? <Inbox className="w-10 h-10" />}
        </div>
        <div className="text-sm font-medium text-zinc-400 dark:text-zinc-500">
          {title ?? t("emptyTitle")}
        </div>
        {description && (
          <div className="text-xs text-zinc-400 dark:text-zinc-500 max-w-xs">
            {description}
          </div>
        )}
        {action && <div className="mt-2">{action}</div>}
      </m.div>
    </AnimatePresence>
  );
}

export default EmptyState;
