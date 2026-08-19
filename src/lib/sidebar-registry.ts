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
  const seen = new Set(items.map((i) => i.key));
  const merged = [...items];
  for (const item of defaults) {
    if (!seen.has(item.key)) {
      seen.add(item.key);
      merged.push(item);
    }
  }
  merged.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  // 快照不可变契约：useSyncExternalStore 以 Object.is 比较前后快照，原地
  // push/sort 引用不变，emit 后 React 判定「无变化」跳过重渲染——任何运行时
  // 动态注册都会静默失效；必须替换为新数组引用
  items = merged;
  emit();
}
