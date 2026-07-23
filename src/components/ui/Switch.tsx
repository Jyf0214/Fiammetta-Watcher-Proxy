"use client";

import { useId } from "react";

export interface SwitchProps {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  loading?: boolean;
  className?: string;
  id?: string;
}

/**
 * 全局自定义开关组件 — 纯 Tailwind CSS 实现
 * 纯开关，不含文字标签。文字由父组件在外部渲染。
 */
export default function Switch({
  checked = false,
  onChange,
  disabled = false,
  loading = false,
  className = "",
  id: propId,
}: SwitchProps) {
  const autoId = useId();
  const switchId = propId ?? autoId;

  const toggle = () => {
    if (disabled || loading) return;
    onChange?.(!checked);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      toggle();
    }
  };

  return (
    <button
      id={switchId}
      role="switch"
      type="button"
      aria-checked={checked}
      aria-disabled={disabled || loading}
      tabIndex={0}
      onClick={toggle}
      onKeyDown={handleKeyDown}
      className={`
        group relative inline-flex h-[22px] w-[40px] shrink-0 cursor-pointer items-center
        rounded-full border-2 border-transparent transition-all duration-200 ease-in-out
        focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500
        ${checked
          ? "bg-blue-500"
          : "bg-zinc-200 dark:bg-zinc-600"
        }
        ${disabled || loading
          ? "cursor-not-allowed opacity-50"
          : "hover:brightness-110 active:scale-95"
        }
        ${className}
      `}
    >
      <span
        className={`
          pointer-events-none inline-flex h-[16px] w-[16px] items-center justify-center
          rounded-full bg-white shadow-sm transition-transform duration-200 ease-in-out
          ${checked ? "translate-x-[18px]" : "translate-x-[2px]"}
          ${loading ? "animate-pulse" : ""}
        `}
      >
        {loading && (
          <svg
            className="absolute inset-0 h-full w-full animate-spin text-blue-400"
            viewBox="0 0 24 24"
            fill="none"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        )}
      </span>
    </button>
  );
}
