"use client";

import { useCallback, useEffect, useState } from "react";
import { useTheme } from "next-themes";

type ThemeMode = "light" | "dark" | "system";

const CYCLE: Record<ThemeMode, ThemeMode> = {
  light: "dark",
  dark: "system",
  system: "light",
};

/**
 * 三态主题模式 hook：light | dark | system
 *
 * 内部委托 next-themes 的 useTheme()，对外保持 { mode, setMode, cycle, isDark, mounted } 接口不变。
 * next-themes 通过 SSR 注入 class 到 <html>，消除首屏闪烁。
 */
export function useThemeMode() {
  const { theme, setTheme, resolvedTheme, systemTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const mode = (theme as ThemeMode) || "system";
  const isDark = mounted ? resolvedTheme === "dark" : false;

  const setMode = useCallback(
    (next: ThemeMode) => {
      setTheme(next);
    },
    [setTheme],
  );

  const cycle = useCallback(() => {
    setTheme(CYCLE[mode]);
  }, [mode, setTheme]);

  return { mode, setMode, cycle, isDark, mounted };
}
