interface EmptyStateProps {
  icon?: React.ReactNode;
  title?: string;
  description?: string;
  action?: React.ReactNode;
  variant?: 'card' | 'minimal';
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  variant = 'card',
}: EmptyStateProps) {
  const containerClass = variant === 'card'
    ? 'py-20 sm:py-32 text-center bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-100 dark:border-zinc-800'
    : 'py-20 text-center';

  return (
    <div className={containerClass}>
      {icon && <div className="flex justify-center mb-4">{icon}</div>}
      {title && <h3 className="text-xl font-bold text-zinc-900 dark:text-zinc-100 mb-2">{title}</h3>}
      {description && <p className="text-zinc-400 text-base mb-4">{description}</p>}
      {action && <div className="flex justify-center">{action}</div>}
    </div>
  );
}
