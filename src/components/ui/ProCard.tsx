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
        "bg-white dark:bg-zinc-900 rounded-xl transition-all duration-300",
        bordered && "border border-zinc-200 dark:border-zinc-700",
        hoverable && "hover:border-zinc-300 dark:hover:border-zinc-600 hover:shadow-md",
        className,
      )}
    >
      {title && (
        <div className={cn("flex items-center justify-between border-b border-zinc-100 dark:border-zinc-800 px-5 py-4")}>
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
