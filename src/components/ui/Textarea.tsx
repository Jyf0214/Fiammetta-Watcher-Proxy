import { type TextareaHTMLAttributes, memo, forwardRef, useId } from 'react';
import { cn } from '@/lib/ui';

export type TextareaSize = 'sm' | 'md' | 'lg';
export type TextareaRounded = 'sm' | 'md' | 'lg' | 'full' | 'none';
export type TextareaRing = 'default' | 'strong';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  /** 最小高度(Tailwind 类,例如 'min-h-[120px]') */
  minH?: string;
  /** 圆角档位 */
  rounded?: TextareaRounded;
  /** 焦点环强度 */
  ring?: TextareaRing;
}

const roundedStyles: Record<TextareaRounded, string> = {
  sm: 'rounded-lg',
  md: 'rounded-xl',
  lg: 'rounded-2xl',
  full: 'rounded-full',
  none: 'rounded-none',
};

const ringStyles: Record<TextareaRing, string> = {
  default: 'focus:border-zinc-400 focus:ring-1 focus:ring-zinc-400',
  strong: 'focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900',
};

/**
 * 自定义多行文本框组件
 * - 默认 p-3 border border-zinc-200 text-sm
 * - minH 控制最小高度(Tailwind 类)
 * - rounded 改变圆角,ring 改变焦点环强度
 */
export const Textarea = memo(
  forwardRef<HTMLTextAreaElement, TextareaProps>(
    (
      {
        className,
        label,
        error,
        id,
        minH = 'min-h-[100px]',
        rounded = 'md',
        ring = 'default',
        ...props
      },
      ref,
    ) => {
      const uniqueId = useId();
      const inputId = id ?? (label ? `${label.toLowerCase().replace(/\s+/g, '-')}-${uniqueId}` : undefined);

      const taEl = (
        <textarea
          ref={ref}
          id={inputId}
          aria-describedby={error ? `${inputId}-error` : undefined}
          className={cn(
            'w-full p-3 border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 text-sm outline-none transition-colors resize-y',
            minH,
            roundedStyles[rounded],
            ringStyles[ring],
            'placeholder:text-zinc-400 dark:placeholder:text-zinc-600',
            error && 'border-red-400 focus:border-red-500 focus:ring-red-500',
            className,
          )}
          {...props}
        />
      );

      if (!label && !error) return taEl;

      return (
        <div className="w-full">
          {label && (
            <label htmlFor={inputId} className="block text-sm font-medium mb-2 text-zinc-700">
              {label}
            </label>
          )}
          {taEl}
          {error && <p id={`${inputId}-error`} className="mt-1 text-xs text-red-500">{error}</p>}
        </div>
      );
    },
  ),
);

Textarea.displayName = 'Textarea';
export default Textarea;
