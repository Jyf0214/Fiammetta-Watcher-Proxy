"use client";

import { Sun, Moon, Monitor } from "lucide-react";
import { useThemeMode } from "@/hooks/use-theme-mode";
import { useTranslation } from "react-i18next";

const ICON_MAP = {
  light: Sun,
  dark: Moon,
  system: Monitor,
} as const;

/**
 * 三态主题切换按钮 — 点击在 light → dark → system 间循环
 */
export function ThemeToggle() {
  const { mode, cycle, mounted } = useThemeMode();
  const { t } = useTranslation("common");

  if (!mounted) {
    return (
      <button
        className="p-2 rounded-lg text-zinc-400 dark:text-zinc-500"
        aria-label={t("themeSystem")}
        disabled
      >
        <Monitor className="w-[18px] h-[18px]" />
      </button>
    );
  }

  const Icon = ICON_MAP[mode] ?? Monitor;
  const labelKey =
    mode === "light" ? "themeLight" : mode === "dark" ? "themeDark" : "themeSystem";

  return (
    <button
      onClick={cycle}
      className="p-2 rounded-lg text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
      aria-label={t(labelKey)}
      title={t(labelKey)}
    >
      <Icon className="w-[18px] h-[18px]" />
    </button>
  );
}

export default ThemeToggle;
