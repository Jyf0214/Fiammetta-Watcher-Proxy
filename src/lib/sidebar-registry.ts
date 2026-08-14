"use client";

import { useSyncExternalStore } from "react";

export interface SidebarItem {
  key: string;
  icon: React.ElementType;
  href: string;
  group: string;
  order?: number;
}

type Listener = () => void;

let items: SidebarItem[] = [];
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return items;
}

/** 注册侧边栏菜单项 */
export function registerSidebarItem(item: SidebarItem) {
  const filtered = items.filter((i) => i.key !== item.key);
  filtered.push(item);
  filtered.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  items = filtered;
  emit();
}

/** 移除侧边栏菜单项 */
export function unregisterSidebarItem(key: string) {
  items = items.filter((i) => i.key !== key);
  emit();
}

/**
 * 侧边栏菜单项 hook — 基于外部 store 订阅，组件卸载时自动清理
 */
export function useSidebarItems() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 在模块加载时批量注册默认菜单项（与原 AdminLayout menuItems 一致） */
export function registerDefaultItems(
  defaults: SidebarItem[],
) {
  for (const item of defaults) {
    if (!items.find((i) => i.key === item.key)) {
      items.push(item);
    }
  }
  items.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  emit();
}
