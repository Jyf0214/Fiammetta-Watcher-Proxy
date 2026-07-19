'use client';

import { ThemeProvider, ConfigProvider } from '@lobehub/ui';
import { motion } from 'motion/react';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ConfigProvider motion={motion}>
      <ThemeProvider
        // 可以自定义主题
        // customTheme={{ primaryColor: '#1677ff' }}
        // 启用全局样式
        enableGlobalStyle
      >
        {children}
      </ThemeProvider>
    </ConfigProvider>
  );
}