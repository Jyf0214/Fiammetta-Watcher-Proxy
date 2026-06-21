"use client";

import type { ReactNode } from "react";
import { Server } from "lucide-react";

interface AuthLayoutProps {
  children: ReactNode;
}

/**
 * 认证页面全屏布局 — 顶部品牌、中部居中内容、底部版权
 */
export default function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <div className="relative min-h-screen w-full flex flex-col bg-zinc-50 dark:bg-zinc-950 p-2">
      <div className="relative overflow-hidden border border-zinc-200 dark:border-zinc-800 rounded-2xl bg-white dark:bg-zinc-900 flex flex-col min-h-[calc(100vh-1rem)]">
        {/* 品牌标题 */}
        <div className="flex items-center gap-2 w-full px-5 py-4">
          <div className="w-7 h-7 bg-zinc-900 dark:bg-zinc-100 rounded-xl flex items-center justify-center">
            <Server className="text-white dark:text-zinc-900 text-xs" />
          </div>
          <span className="text-lg font-bold text-zinc-900 dark:text-zinc-100">
            Fiammetta
          </span>
        </div>

        {/* 居中内容 */}
        <div className="flex-1 flex items-center justify-center w-full p-4">
          {children}
        </div>

        {/* 底部版权 */}
        <div className="flex items-center justify-center py-5">
          <span className="text-xs text-zinc-400 dark:text-zinc-500 text-center">
            Fiammetta Watcher Proxy © {new Date().getFullYear()}
          </span>
        </div>
      </div>
    </div>
  );
}
