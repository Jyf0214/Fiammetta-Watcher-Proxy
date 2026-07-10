"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { useTranslation } from "react-i18next";
import { useUser } from "@/context/user";
import "@/lib/i18n";

interface NavItem {
  key: string;
  href: string;
  icon: string;
}

const NAV_ITEMS: NavItem[] = [
  { key: "dashboard", href: "/admin", icon: "📊" },
  { key: "platforms", href: "/admin/platforms", icon: "🌐" },
  { key: "proxies", href: "/admin/proxies", icon: "🔗" },
  { key: "keys", href: "/admin/keys", icon: "🔑" },
  { key: "models", href: "/admin/models", icon: "🔄" },
  { key: "auto_model", href: "/admin/auto-model", icon: "⚡" },
  { key: "logs", href: "/admin/logs", icon: "📝" },
  { key: "events", href: "/admin/events", icon: "🚨" },
  { key: "audit", href: "/admin/audit", icon: "📋" },
  { key: "usage", href: "/admin/usage", icon: "📈" },
  { key: "system", href: "/admin/system", icon: "⚙️" },
];

export default function AdminLayoutClient({
  children,
}: {
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const { user, logout } = useUser();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const isActive = (href: string) => {
    if (href === "/admin") {
      return pathname === "/admin" || pathname === "/admin/";
    }
    return pathname.includes(href);
  };

  const sidebarWidth = collapsed ? "w-16" : "w-60";

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 flex">
      {/* 移动端遮罩 */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* 侧边栏 */}
      <aside
        className={`fixed lg:sticky top-0 left-0 h-screen ${sidebarWidth} bg-white dark:bg-zinc-900 border-r border-zinc-200 dark:border-zinc-800 z-50 transition-all duration-300 flex flex-col ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        }`}
      >
        {/* Logo */}
        <div className="h-14 flex items-center border-b border-zinc-200 dark:border-zinc-800 px-4">
          {!collapsed && (
            <Link href="/admin" className="flex items-center gap-2">
              <span className="text-xl font-bold text-zinc-900 dark:text-zinc-100">
                F
              </span>
              <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Fiammetta
              </span>
            </Link>
          )}
          {collapsed && (
            <Link href="/admin" className="flex items-center justify-center w-full">
              <span className="text-xl font-bold text-zinc-900 dark:text-zinc-100">
                F
              </span>
            </Link>
          )}
        </div>

        {/* 导航 */}
        <nav className="flex-1 overflow-y-auto py-2 px-2">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors mb-0.5 ${
                isActive(item.href)
                  ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-medium"
                  : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
              }`}
              title={collapsed ? t(`nav.${item.key}`) : undefined}
            >
              <span className="text-base">{item.icon}</span>
              {!collapsed && <span>{t(`nav.${item.key}`)}</span>}
            </Link>
          ))}
        </nav>

        {/* 底部用户信息 */}
        <div className="border-t border-zinc-200 dark:border-zinc-800 p-2">
          {!collapsed && user && (
            <div className="px-3 py-2 text-sm text-zinc-500 dark:text-zinc-400">
              {user.username}
            </div>
          )}
          <button
            onClick={() => logout()}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors ${
              collapsed ? "justify-center" : ""
            }`}
            title={collapsed ? t("auth.logout") : undefined}
          >
            <span className="text-base">🚪</span>
            {!collapsed && <span>{t("auth.logout")}</span>}
          </button>
        </div>
      </aside>

      {/* 主内容区 */}
      <div className="flex-1 min-w-0">
        {/* 顶部栏 */}
        <header className="sticky top-0 z-30 h-14 bg-white/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b border-zinc-200 dark:border-zinc-800 flex items-center px-4 gap-3">
          {/* 移动端菜单按钮 */}
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="lg:hidden p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <span className="text-lg">☰</span>
          </button>

          {/* 折叠按钮 */}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="hidden lg:block p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800"
            title={collapsed ? "展开侧边栏" : "折叠侧边栏"}
          >
            <span className="text-lg">{collapsed ? "▶" : "◀"}</span>
          </button>

          <div className="flex-1" />

          {/* 语言切换 */}
          <button
            onClick={() => {
              const newLocale = document.documentElement.lang === "zh" ? "en" : "zh";
              document.cookie = `NEXT_LOCALE=${newLocale};path=/;max-age=31536000`;
              window.location.reload();
            }}
            className="p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 text-sm"
          >
            🌐
          </button>
        </header>

        {/* 页面内容 */}
        <main className="p-4">{children}</main>
      </div>
    </div>
  );
}
