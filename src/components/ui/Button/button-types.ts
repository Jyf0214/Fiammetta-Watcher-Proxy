import { type ButtonHTMLAttributes, type ReactNode } from 'react';

export type ButtonVariant =
  | 'primary'
  | 'default'
  | 'secondary'
  | 'danger'
  | 'dangerGhost'
  | 'ghost'
  | 'link'
  | 'success'
  | 'warning'
  | 'filled';
export type ButtonSize = 'sm' | 'md' | 'lg';
export type ButtonRounded = 'sm' | 'md' | 'lg' | 'full' | 'none';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  rounded?: ButtonRounded;
  loading?: boolean;
  /** 自动加载动画（默认开启）：点击按钮后自动进入轻加载动画状态，按钮变淡且不可重复点击。
   *  若 `onClick` 返回 Promise，加载状态会在 Promise 完成后自动解除。
   *  设为 `false` 可禁用此行为。 */
  autoLoading?: boolean;
  icon?: ReactNode;
  iconOnly?: boolean;
  block?: boolean;
}
