'use client';

import type { ReactNode } from 'react';

export interface FilterPillProps {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
  icon?: ReactNode;
  className?: string;
}

const baseStyles =
  'shrink-0 px-4 py-2 rounded-full text-sm font-medium transition-all duration-200 active:scale-95 whitespace-nowrap';

export function FilterPill({
  selected,
  onClick,
  children,
  icon,
  className = '',
}: FilterPillProps) {
  // 修复：添加深色模式样式适配
  const selectedStyles = 'bg-zinc-900 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-900';
  const unselectedStyles =
    'bg-white text-zinc-600 border border-zinc-200 hover:border-zinc-300 hover:text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400 dark:border-zinc-700 dark:hover:border-zinc-600 dark:hover:text-zinc-300';

  const classes = [
    baseStyles,
    selected ? selectedStyles : unselectedStyles,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button type="button" className={classes} aria-pressed={selected} onClick={onClick}>
      {icon && <span className="shrink-0">{icon}</span>}
      <span>{children}</span>
    </button>
  );
}
