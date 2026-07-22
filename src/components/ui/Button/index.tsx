'use client';

import { memo, forwardRef } from 'react';
import { cn } from '@/lib/ui';
import type { ButtonProps, ButtonVariant, ButtonSize, ButtonRounded } from './button-types';
import { variantStyles, sizePadding, iconOnlySize, roundedStyles, BASE_BUTTON_CLASSES } from './button-styles';
import { useAutoLoading } from './use-auto-loading';
import { LoadingSpinner } from './LoadingSpinner';

export type { ButtonProps, ButtonVariant, ButtonSize, ButtonRounded };

/** 渲染按钮图标/loading 区域 */
function renderIcon(showLoading: boolean, icon: React.ReactNode) {
  if (showLoading) return <LoadingSpinner />;
  if (icon) return <span className="flex-shrink-0">{icon}</span>;
  return null;
}

/**
 * 自定义按钮组件 — 支持 primary/default/danger 等变体
 *
 * - autoLoading：默认开启，点击后自动进入轻加载动画
 * - iconOnly：纯图标按钮，自动等宽高（square）
 * - rounded：独立控制圆角大小（sm/md/lg/full/none）
 * - block：块级按钮（w-full）
 * - icon+text 组合时，移动端自动隐藏文字只显示图标
 */
export const Button = memo(
  forwardRef<HTMLButtonElement, ButtonProps>(
    ({ children, variant = 'default', size = 'md', rounded, loading, autoLoading = true, icon, iconOnly, block, className, disabled, onClick, ...props }, ref) => {
      const isIconOnly = iconOnly || (icon && !children);
      const isResponsiveIcon = !isIconOnly && !!icon && !!children;
      const { isLoading, handleClick, showLoading } = useAutoLoading(loading, autoLoading, disabled, onClick);

      const btnClassName = cn(
        BASE_BUTTON_CLASSES,
        variantStyles[variant],
        isIconOnly ? iconOnlySize[size] : sizePadding[size],
        roundedStyles[rounded ?? 'md'],
        block && 'w-full',
        !!isLoading && 'animate-btn-loading',
        isResponsiveIcon && `max-sm:w-auto ${iconOnlySize[size]}`,
        className,
      );

      return (
        <button
          ref={ref}
          disabled={disabled || isLoading}
          onClick={handleClick}
          className={btnClassName}
          {...props}
        >
          {renderIcon(showLoading, icon)}
          {isResponsiveIcon ? (
            <span className="hidden sm:inline-flex items-center">{children}</span>
          ) : (
            children
          )}
        </button>
      );
    },
  ),
);

Button.displayName = 'Button';
export default Button;
