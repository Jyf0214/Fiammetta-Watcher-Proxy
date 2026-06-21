import { type InputHTMLAttributes, memo, forwardRef, useId } from 'react';
import { cn } from '@/lib/ui';

export type InputSize = 'sm' | 'md' | 'lg' | 'xl';
export type InputRounded = 'sm' | 'md' | 'lg' | 'full' | 'none';
export type InputRing = 'default' | 'strong';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string;
  error?: string;
  /** 高度档位:sm=h-9 / md=h-10 / lg=h-11 / xl=h-12 */
  size?: InputSize;
  /** 圆角档位:sm=rounded-lg / md=rounded-xl / lg=rounded-2xl / full=rounded-full / none=rounded-none */
  rounded?: InputRounded;
  /** 焦点环强度:default=ring-1 ring-zinc-400 / strong=ring-2 ring-zinc-900 */
  ring?: InputRing;
}

const sizeStyles: Record<InputSize, string> = {
  sm: 'h-9 px-3 text-xs',
  md: 'h-10 px-3 text-sm',
  lg: 'h-11 px-4 text-sm',
  xl: 'h-12 px-4 text-base',
};

const roundedStyles: Record<InputRounded, string> = {
  sm: 'rounded-lg',
  md: 'rounded-xl',
  lg: 'rounded-2xl',
  full: 'rounded-full',
  none: 'rounded-none',
};

const ringStyles: Record<InputRing, string> = {
  default: 'focus:border-zinc-400 focus:ring-1 focus:ring-zinc-400',
  strong: 'focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900',
};

/**
 * 自定义输入框组件
 * - 默认 h-10 px-3 rounded-lg text-sm + focus:ring-1 focus:ring-zinc-400
 * - size 改变高度,rounded 改变圆角,ring 改变焦点环强度
 */
export const Input = memo(
  forwardRef<HTMLInputElement, InputProps>(
    ({ className, label, error, id, size = 'md', rounded = 'sm', ring = 'default', ...props }, ref) => {
      const uniqueId = useId();
      const inputId = id ?? (label ? `${label.toLowerCase().replace(/\s+/g, '-')}-${uniqueId}` : undefined);

      const inputEl = (
        <input
          ref={ref}
          id={inputId}
          aria-describedby={error ? `${inputId}-error` : undefined}
          className={cn(
            'w-full border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 outline-none transition-colors',
            sizeStyles[size],
            roundedStyles[rounded],
            ringStyles[ring],
            'placeholder:text-zinc-400 dark:placeholder:text-zinc-600',
            error && 'border-red-400 focus:border-red-500 focus:ring-red-500',
            className,
          )}
          {...props}
        />
      );

      if (!label && !error) return inputEl;

      return (
        <div className="w-full">
          {label && (
            <label htmlFor={inputId} className="block text-sm font-medium mb-2 text-zinc-700">
              {label}
            </label>
          )}
          {inputEl}
          {error && <p id={`${inputId}-error`} className="mt-1 text-xs text-red-500">{error}</p>}
        </div>
      );
    },
  ),
);

Input.displayName = 'Input';
export default Input;
