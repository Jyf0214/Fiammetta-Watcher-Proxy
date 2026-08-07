"use client";

import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

interface GlobalLoadingProps {
  size?: "small" | "default" | "large";
  tip?: string;
}

const sizeMap = {
  small: 16,
  default: 24,
  large: 40,
};

const textSizeMap = {
  small: "text-xs",
  default: "text-sm",
  large: "text-base",
};

/**
 * 全局加载占位组件 — lucide-react Loader2 旋转动画
 */
export default function GlobalLoading({ size = "large", tip }: GlobalLoadingProps) {
  const { t } = useTranslation("common");
  return (
    <div className="flex flex-col items-center justify-center min-h-[200px] gap-3" role="status" aria-label={t("loading")}>
      <Loader2
        size={sizeMap[size]}
        className="animate-spin text-zinc-300 dark:text-zinc-600"
      />
      {tip && (
        <span className={`${textSizeMap[size]} text-zinc-400 dark:text-zinc-500`}>
          {tip}
        </span>
      )}
    </div>
  );
}
