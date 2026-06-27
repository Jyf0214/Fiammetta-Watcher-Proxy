import { useId } from 'react';
import { Switch } from 'antd';

export interface ToggleFieldProps {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  className?: string;
}

export default function ToggleField({
  label,
  description,
  checked,
  onChange,
  className = '',
}: ToggleFieldProps) {
  const switchId = useId();

  return (
    <div className={`flex items-center justify-between py-3 px-4 bg-zinc-50 dark:bg-zinc-800 rounded-xl ${className}`}>
      <div>
        <label htmlFor={switchId} className="text-sm font-medium text-zinc-900">{label}</label>
        {description && (
          <div className="text-xs text-zinc-400 mt-0.5">{description}</div>
        )}
      </div>
      <Switch id={switchId} checked={checked} onChange={onChange} />
    </div>
  );
}
