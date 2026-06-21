'use client';

import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'theme-mode';

type ThemeMode = 'light' | 'dark' | 'system';

const CYCLE: Record<ThemeMode, ThemeMode> = {
  light: 'dark',
  dark: 'system',
  system: 'light',
};

/** 根据 mode 判断当前实际是否深色 */
function resolveDark(mode: ThemeMode, systemDark: boolean): boolean {
  if (mode === 'system') return systemDark;
  return mode === 'dark';
}

/** 将 <html> class 同步为 dark / 空 */
function applyClass(dark: boolean) {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  if (dark) {
    html.classList.add('dark');
  } else {
    html.classList.remove('dark');
  }
}

/**
 * 三态主题模式 hook：light | dark | system
 *
 * - 持久化到 localStorage
 * - system 模式下跟随 prefers-color-scheme
 * - 在 <html> 元素上设置 / 移除 class="dark"
 */
export function useThemeMode() {
  const [mode, setModeState] = useState<ThemeMode>('system');
  const [systemDark, setSystemDark] = useState(false);
  const [mounted, setMounted] = useState(false);

  // 初始化：读取 localStorage + 监听系统偏好
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY) as ThemeMode | null;
    const initial: ThemeMode = saved && ['light', 'dark', 'system'].includes(saved) ? saved : 'system';
    setModeState(initial);

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    setSystemDark(mq.matches);

    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', handler);
    setMounted(true);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // mode 或 systemDark 变化时同步 <html> class
  useEffect(() => {
    if (!mounted) return;
    applyClass(resolveDark(mode, systemDark));
  }, [mode, systemDark, mounted]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    localStorage.setItem(STORAGE_KEY, next);
  }, []);

  const cycle = useCallback(() => {
    setMode(CYCLE[mode]);
  }, [mode, setMode]);

  const isDark = mounted ? resolveDark(mode, systemDark) : false;

  return { mode, setMode, cycle, isDark, mounted };
}
