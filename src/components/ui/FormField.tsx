import React from 'react';
import { Select, Input as AntInput } from 'antd';
import { Input } from '@/components/ui/Input';

export interface FormFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'textarea' | 'select';
  placeholder?: string;
  options?: { value: string; label: string }[];
  rows?: number;
  className?: string;
}

export default function FormField({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  options,
  rows = 4,
  className = '',
}: FormFieldProps) {
  return (
    <div className={className}>
      <label className="block text-sm font-medium mb-2">{label}</label>
      {type === 'textarea' && (
        <AntInput.TextArea
          rows={rows}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
        />
      )}
      {type === 'select' && options && (
        <Select
          value={value}
          onChange={onChange}
          options={options}
          style={{ width: '100%' }}
        />
      )}
      {type === 'text' && (
        <Input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
        />
      )}
    </div>
  );
}
