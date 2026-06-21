/**
 * UI Utility Library for Originium Kernel
 * Integrates LobeUI and AntD design patterns
 */

import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge class names with Tailwind CSS
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * LobeUI Button Variants
 */
export const buttonVariants = {
  primary: 'bg-[#1677ff] text-white hover:bg-[#4096ff]',
  default: 'bg-white border border-zinc-300 text-zinc-700 hover:border-[#1677ff] hover:text-[#1677ff]',
  danger: 'bg-white border border-red-300 text-red-600 hover:border-red-500 hover:bg-red-50',
  ghost: 'text-zinc-600 hover:bg-zinc-100',
  link: 'text-[#1677ff] hover:underline',
} as const;

export type ButtonVariant = keyof typeof buttonVariants;

/**
 * LobeUI Card Variants
 */
export const cardVariants = {
  default: 'bg-white rounded-xl border border-zinc-200 shadow-sm',
  elevated: 'bg-white rounded-xl shadow-md border border-zinc-100',
  outlined: 'bg-transparent rounded-xl border border-zinc-300',
  filled: 'bg-zinc-50 rounded-xl border border-zinc-200',
} as const;

export type CardVariant = keyof typeof cardVariants;

/**
 * Status badge colors
 */
export const statusColors = {
  success: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  warning: 'bg-amber-100 text-amber-700 border-amber-200',
  error: 'bg-red-100 text-red-700 border-red-200',
  info: 'bg-blue-100 text-blue-700 border-blue-200',
  default: 'bg-zinc-100 text-zinc-700 border-zinc-200',
} as const;

export type StatusType = keyof typeof statusColors;
