import { type ReactNode, memo } from "react";
import { cn } from "@/lib/ui";

export interface ProCardProps {
  title?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  hoverable?: boolean;
  bordered?: boolean;
  padding?: string;
}

export const ProCard = memo<ProCardProps>(({
  title,
  extra,
  children,
  className,
  bodyClassName,
  hoverable = false,
  bordered = true,
  padding = "p-5",
}) => {
  return (
    <div
      className={cn(
        "bg-white dark:bg-zinc-900 rounded-xl transition-all duration-200",
        // bordered=false 时不渲染边框（无边框卡片用于嵌入已有分栏等场景）
        bordered && "border border-zinc-200/80 dark:border-zinc-800",
        hoverable && "hover:border-zinc-300 dark:hover:border-zinc-700",
        className,
      )}
    >
      {title && (
        <div className={cn("flex items-center justify-between border-b border-zinc-100 dark:border-zinc-800 px-4 py-3")}>
          <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</div>
          {extra && <div className="flex items-center gap-2">{extra}</div>}
        </div>
      )}
      <div className={cn(padding, bodyClassName)}>
        {children}
      </div>
    </div>
  );
});
ProCard.displayName = "ProCard";

export default ProCard;
