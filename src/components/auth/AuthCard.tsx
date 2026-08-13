import type { ReactNode } from "react";

interface AuthCardProps {
  children?: ReactNode;
  footer?: ReactNode;
  subtitle?: ReactNode;
  title?: ReactNode;
}

/**
 * 认证卡片 — 承载标题、副标题、表单内容和底部操作区
 */
export default function AuthCard({
  children,
  title,
  subtitle,
  footer,
}: AuthCardProps) {
  return (
    <div className="w-full max-w-[480px]">
      {/* 标题区域 */}
      <div className="mb-12">
        {title && (
          <div className="mb-4">
            <span className="block text-2xl font-bold leading-[1.4] tracking-tight text-zinc-900 dark:text-zinc-100">
              {title}
            </span>
          </div>
        )}
        {subtitle && (
          <span className="block text-sm leading-[1.6] text-zinc-500 dark:text-zinc-400">
            {subtitle}
          </span>
        )}
      </div>

      {/* 内容区域 */}
      <div className="mb-8">{children}</div>

      {/* 底部操作区 */}
      {footer}
    </div>
  );
}
