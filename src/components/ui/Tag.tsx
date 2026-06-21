import { type ReactNode, type CSSProperties, type KeyboardEvent, memo } from 'react';
import { cn } from '@/lib/ui';

type TagVariant = 'light' | 'dark' | 'outline' | 'emerald' | 'amber' | 'danger' | 'success' | 'warning';
type TagSize = 'xs' | 'sm' | 'md' | 'lg';

const variantStyles: Record<TagVariant, string> = {
  light: 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700',
  dark: 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 border-zinc-800 dark:border-zinc-300',
  outline: 'bg-white dark:bg-transparent text-zinc-500 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700',
  emerald: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-700',
  amber: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-700',
  danger: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 border-red-200 dark:border-red-700',
  success: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-700',
  warning: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-700',
};

const sizeStyles: Record<TagSize, string> = {
  xs: 'px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full',
  sm: 'px-2 py-0.5 text-xs rounded',
  md: 'px-3 py-1 text-xs font-bold uppercase tracking-widest rounded-full',
  lg: 'px-4 py-1.5 text-sm font-medium rounded-full',
};

export interface TagProps {
  children: ReactNode;
  variant?: TagVariant;
  size?: TagSize;
  className?: string;
  style?: CSSProperties;
  onClick?: () => void;
}

/**
 * 自定义标签组件 — 支持 light/emerald/amber/danger 等变体
 */
export const Tag = memo<TagProps>(({ children, variant = 'light', size = 'md', className, style, onClick }) => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick?.();
    }
  };

  const classes = cn(
    'inline-block border',
    variantStyles[variant],
    sizeStyles[size],
    onClick && 'cursor-pointer hover:opacity-80 transition-opacity',
    className,
  );

  if (onClick) {
    return (
      <button type="button" className={classes} style={style} onClick={onClick} onKeyDown={handleKeyDown}>
        {children}
      </button>
    );
  }

  return (
    <span className={classes} style={style}>
      {children}
    </span>
  );
});

Tag.displayName = 'Tag';
export default Tag;
