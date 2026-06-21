'use client';

import { useEffect, useCallback, useRef } from 'react';

/** 快捷键映射：key → callback。key 支持小写字母、Shift+key 等组合 */
export type ShortcutMap = Record<string, () => void>;

/**
 * 全局快捷键 hook
 * - 忽略 input/textarea/select/可编辑元素中的按键
 * - 忽略 ctrl/meta/alt 组合键（保留 Shift+key 等单修饰键场景）
 * - 支持 Shift+? 等组合
 */
export function useKeyboardShortcuts(shortcuts: ShortcutMap) {
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  const handler = useCallback((e: KeyboardEvent) => {
    // 忽略 ctrl/meta/alt 组合键
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    // 忽略输入类元素中的按键
    const target = e.target as HTMLElement;
    if (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' ||
      target.isContentEditable
    ) {
      return;
    }

    // 构造快捷键标识：Shift+key 或单独 key
    const key = e.shiftKey ? `Shift+${e.key}` : e.key;
    const callback = shortcutsRef.current[key];
    if (callback) {
      e.preventDefault();
      callback();
    }
  }, []);

  useEffect(() => {
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handler]);
}
