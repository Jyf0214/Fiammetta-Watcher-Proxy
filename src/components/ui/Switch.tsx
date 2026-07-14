"use client";

import { useId } from "react";

export interface SwitchProps {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  loading?: boolean;
  checkedChildren?: React.ReactNode;
  unCheckedChildren?: React.ReactNode;
  className?: string;
  id?: string;
}

/**
 * 全局自定义开关组件 — 纯 Tailwind CSS 实现
 * 替代 antd Switch，提供一致的亮色/暗色模式体验
 */
export default function Switch({
  checked = false,
  onChange,
  disabled = false,
  loading = false,
  checkedChildren,
  unCheckedChildren,
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
        group relative inline-flex h-[22px] min-w-[44px] cursor-pointer items-center
        rounded-full border-2 border-transparent transition-all duration-300 ease-in-out
        focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500
        ${checked
          ? "bg-blue-500 dark:bg-blue-500"
          : "bg-zinc-200 dark:bg-zinc-600"
        }
        ${disabled || loading
          ? "cursor-not-allowed opacity-50"
          : "hover:brightness-110 active:scale-95"
        }
        ${className}
      `}
    >
      {/* 滑块 */}
      <span
        className={`
          pointer-events-none relative inline-flex h-[16px] w-[16px] items-center justify-center
          rounded-full bg-white shadow-sm transition-all duration-300 ease-in-out
          ${checked ? "translate-x-[22px]" : "translate-x-[2px]"}
          ${loading ? "animate-pulse" : ""}
          ${disabled ? "" : "group-hover:shadow-md"}
        `}
      >
        {/* 加载动画 */}
        {loading && (
          <svg
            className="absolute inset-0 h-full w-full animate-spin text-blue-400"
            viewBox="0 0 24 24"
            fill="none"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="3"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
        )}
      </span>

      {/* 文字标签（仅在有内容时显示，扩展宽度） */}
      {(checkedChildren || unCheckedChildren) && (
        <span
          className={`
            absolute inset-0 flex items-center justify-center text-[10px] font-bold leading-none
            transition-all duration-300 select-none pointer-events-none
            ${checked
              ? "text-white/90 pr-[28px] pl-[6px]"
              : "text-zinc-500 dark:text-zinc-400 pl-[26px] pr-[6px]"
            }
          `}
        >
          {checked ? checkedChildren : unCheckedChildren}
        </span>
      )}
    </button>
  );
}
