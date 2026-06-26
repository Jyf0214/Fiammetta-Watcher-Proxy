"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useTranslation } from "react-i18next";
import { useThemeMode } from "@/hooks/use-theme-mode";
import {
  LayoutDashboard,
  Server,
  Key,
  ArrowLeftRight,
  FileText,
  ScrollText,
  Settings,
  Bell,
  LogOut,
  Sun,
  Moon,
  Globe,
  Menu,
  X,
  ChevronDown,
  ChevronRight,
  Shield,
} from "lucide-react";
import "@/lib/i18n";

// ---------- 类型定义 ----------
interface MenuItem {
  key: string;
  icon: React.ElementType;
  href: string;
  group: string;
}

// ---------- 菜单配置 ----------
const menuItems: MenuItem[] = [
  { key: "admin.dashboard", icon: LayoutDashboard, href: "/admin", group: "overview" },
  { key: "admin.platforms", icon: Server, href: "/admin/platforms", group: "manage" },
  { key: "admin.keys", icon: Key, href: "/admin/keys", group: "manage" },
  { key: "admin.models", icon: ArrowLeftRight, href: "/admin/models", group: "manage" },
  { key: "admin.logs", icon: FileText, href: "/admin/logs", group: "monitor" },
  { key: "admin.audit", icon: ScrollText, href: "/admin/audit", group: "monitor" },
  { key: "admin.events", icon: Bell, href: "/admin/events", group: "monitor" },
  { key: "admin.system", icon: Settings, href: "/admin/system", group: "system" },
];

const groupLabels: Record<string, string> = {
  overview: "概览",
  manage: "管理",
  monitor: "监控",
  system: "系统",
};

// ---------- SidebarItem ----------
function SidebarItem({
  item,
  isActive,
  onClick,
  t,
}: {
  item: MenuItem;
  isActive: boolean;
  onClick: () => void;
  t: (key: string) => string;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      prefetch={false}
      onClick={onClick}
      className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all duration-300 no-underline ${
        isActive
          ? "bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 shadow-lg shadow-zinc-200 dark:shadow-zinc-400/20"
          : "text-zinc-500 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100"
      }`}
    >
      <Icon
        size={18}
        className={`shrink-0 transition-colors ${
          isActive ? "text-white" : "text-zinc-300 dark:text-zinc-600"
        }`}
      />
      <span className={`truncate ${isActive ? "font-bold" : "font-medium"}`}>
        {t(item.key)}
      </span>
      {isActive && (
        <div className="ml-auto w-1 h-4 bg-white/20 dark:bg-zinc-900/20 rounded-full" />
      )}
    </Link>
  );
}

// ---------- SidebarGroup ----------
function SidebarGroup({
  group,
  items: groupItems,
  isCollapsed,
  onToggle,
  isActive,
  onItemClick,
  t,
}: {
  group: string;
  items: MenuItem[];
  isCollapsed: boolean;
  onToggle: () => void;
  isActive: (href: string) => boolean;
  onItemClick: () => void;
  t: (key: string) => string;
}) {
  return (
    <div className="space-y-1.5">
      <button
        onClick={onToggle}
        className="flex items-center justify-between w-full px-3 mb-1"
      >
        <span className="text-[10px] font-black uppercase tracking-[0.2em] text-zinc-300 dark:text-zinc-600">
          {groupLabels[group] ?? group}
        </span>
        <ChevronDown
          size={12}
          className={`text-zinc-200 dark:text-zinc-700 transition-transform duration-300 ${
            isCollapsed ? "-rotate-90" : ""
          }`}
        />
      </button>
      {!isCollapsed && (
        <div className="space-y-0.5">
          {groupItems.map((item) => (
            <SidebarItem
              key={item.href}
              item={item}
              isActive={isActive(item.href)}
              onClick={onItemClick}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- SidebarUserMenu ----------
function SidebarUserMenu({
  username,
  onLogout,
  t,
}: {
  username: string;
  onLogout: () => void;
  t: (key: string) => string;
}) {
  return (
    <div className="p-4 space-y-4 bg-zinc-50/50 dark:bg-zinc-800/50 border-b border-zinc-100 dark:border-zinc-800">
      <div className="flex items-center gap-3 p-2.5 rounded-2xl bg-white dark:bg-zinc-800 border border-zinc-100 dark:border-zinc-700 shadow-sm">
        <div className="w-10 h-10 rounded-full bg-zinc-900 dark:bg-zinc-100 flex items-center justify-center shrink-0">
          <Shield size={18} className="text-white dark:text-zinc-900" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-zinc-900 dark:text-zinc-100 truncate">
            {username}
          </div>
          <div className="text-[10px] font-bold text-zinc-400 uppercase tracking-tighter">
            Administrator
          </div>
        </div>
        <button
          onClick={onLogout}
          className="p-2 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors text-zinc-400 hover:text-red-500"
          title={t("auth.logout")}
          aria-label={t("auth.logout")}
        >
          <LogOut size={18} />
        </button>
      </div>
    </div>
  );
}

// ---------- MobileToggle ----------
function MobileToggle({
  isOpen,
  onClick,
}: {
  isOpen: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={isOpen ? "关闭侧边栏" : "打开侧边栏"}
      className={`md:hidden ${isOpen ? "hidden" : ""} fixed top-6 left-6 z-[9999] rounded-2xl p-3.5 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 shadow-2xl shadow-zinc-900/20 hover:scale-110 active:scale-95 transition-transform`}
    >
      {isOpen ? <X size={22} /> : <Menu size={22} />}
    </button>
  );
}

// ---------- TopHeader ----------
function TopHeader({
  pathname,
  t,
  isDark,
  cycle,
  mode,
  i18n,
  toggleLanguage,
}: {
  pathname: string;
  t: (key: string) => string;
  isDark: boolean;
  cycle: () => void;
  mode: string;
  i18n: { language: string; changeLanguage: (lang: string) => void };
  toggleLanguage: () => void;
}) {
  const breadcrumbMap: Record<string, string> = {
    "/admin": "admin.dashboard",
    "/admin/platforms": "admin.platforms",
    "/admin/keys": "admin.keys",
    "/admin/models": "admin.models",
    "/admin/logs": "admin.logs",
    "/admin/audit": "admin.audit",
    "/admin/system": "admin.system",
    "/admin/events": "admin.events",
  };

  const breadcrumbKey = breadcrumbMap[pathname] ?? "admin.dashboard";
  const breadcrumb = t(breadcrumbKey);

  return (
    <header className="h-16 bg-white dark:bg-zinc-900 border-b border-zinc-100 dark:border-zinc-800 flex items-center px-4 md:px-6 sticky top-0 z-50">
      <nav className="flex items-center gap-1.5 text-sm text-zinc-400">
        <span className="hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors">
          {t("admin.dashboard")}
        </span>
        {breadcrumb && (
          <>
            <ChevronRight size={14} className="text-zinc-300 dark:text-zinc-600 shrink-0" />
            <span className="font-medium text-zinc-700 dark:text-zinc-200">
              {breadcrumb}
            </span>
          </>
        )}
      </nav>
      <div className="ml-auto flex items-center gap-1">
        <button
          onClick={cycle}
          className="p-2 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
          title={mode === "dark" ? t("theme.light") : t("theme.dark")}
        >
          {isDark ? <Sun size={18} /> : <Moon size={18} />}
        </button>
        <button
          onClick={toggleLanguage}
          className="p-2 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
        >
          <Globe size={18} />
        </button>
      </div>
    </header>
  );
}

// ---------- 主布局 ----------
export default function AdminPageLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const { mode, cycle, isDark } = useThemeMode();
  const [username, setUsername] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  const isLoginPage = pathname === "/admin/login";

  const open = useCallback(() => setSidebarOpen(true), []);
  const close = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    if (isLoginPage) return;
    checkAuth();
  }, [isLoginPage]);

  const checkAuth = async () => {
    try {
      const res = await fetch("/api/admin/auth");
      const data = await res.json();
      if (data.success) {
        setUsername(data.data.username);
      } else {
        router.push("/admin/login");
      }
    } catch {
      router.push("/admin/login");
    }
  };

  const handleLogout = async () => {
    try {
      await fetch("/api/admin/auth", { method: "DELETE" });
      router.push("/");
    } catch {
      // 忽略
    }
  };

  const toggleLanguage = () => {
    const newLang = i18n.language === "zh" ? "en" : "zh";
    i18n.changeLanguage(newLang);
  };

  const isActive = (href: string) => {
    if (href === "/admin") return pathname === "/admin";
    return pathname.startsWith(href);
  };

  const toggleGroup = (group: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [group]: !prev[group] }));
  };

  const grouped = menuItems.reduce<Record<string, MenuItem[]>>((acc, item) => {
    const g = item.group;
    acc[g] ??= [];
    acc[g].push(item);
    return acc;
  }, {});

  // 登录页不使用管理后台布局
  if (isLoginPage) {
    return <>{children}</>;
  }

  const sidebarContent = (
    <div className="flex flex-col h-full bg-white dark:bg-zinc-900 border-r border-zinc-100 dark:border-zinc-800">
      {/* 品牌头 */}
      <div className="px-5 py-6 flex items-center justify-between border-b border-zinc-50/50 dark:border-zinc-800/50">
        <Link href="/" className="flex items-center gap-3 group no-underline">
          <div className="w-9 h-9 bg-zinc-900 dark:bg-zinc-100 rounded-xl flex items-center justify-center shadow-lg shadow-zinc-200 dark:shadow-zinc-700 group-hover:scale-105 transition-transform duration-300">
            <span className="text-white dark:text-zinc-900 font-black text-lg tracking-tighter">
              FW
            </span>
          </div>
          <div className="flex flex-col">
            <span className="font-bold text-sm tracking-tight text-zinc-900 dark:text-zinc-100 leading-none mb-0.5">
              Fiammetta
            </span>
            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest leading-none">
              Watcher Proxy
            </span>
          </div>
        </Link>
        <button
          onClick={close}
          className="md:hidden p-2 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors text-zinc-400"
          aria-label="关闭侧边栏"
        >
          <X size={18} />
        </button>
      </div>

      {/* 用户信息 */}
      <SidebarUserMenu username={username} onLogout={handleLogout} t={t} />

      {/* 菜单 */}
      <nav className="flex-1 overflow-y-auto px-3 py-6 space-y-7 custom-scrollbar">
        {Object.entries(grouped).map(([group, groupItems]) => (
          <SidebarGroup
            key={group}
            group={group}
            items={groupItems}
            isCollapsed={!!collapsedGroups[group]}
            onToggle={() => toggleGroup(group)}
            isActive={isActive}
            onItemClick={close}
            t={t}
          />
        ))}
      </nav>
    </div>
  );

  return (
    <div className={`flex min-h-screen overflow-x-hidden ${isDark ? "dark" : ""}`}>
      {/* 移动端汉堡按钮 */}
      <MobileToggle isOpen={sidebarOpen} onClick={sidebarOpen ? close : open} />

      {/* 桌面端侧边栏 */}
      <div className="hidden md:flex w-[280px] min-h-screen z-[100] bg-white dark:bg-zinc-900 flex-col shrink-0">
        {sidebarContent}
      </div>

      {/* 移动端遮罩层 */}
      {sidebarOpen && (
        <div
          className="md:hidden fixed inset-0 bg-zinc-900/40 backdrop-blur-md z-[998] transition-opacity duration-300"
          aria-hidden="true"
          onClick={close}
        />
      )}

      {/* 移动端侧边栏 */}
      <div
        className="md:hidden fixed top-0 h-screen w-[300px] z-[999] bg-white dark:bg-zinc-900 shadow-[20px_0_60px_-15px_rgba(0,0,0,0.3)] transition-transform duration-500"
        style={{
          left: 0,
          transform: sidebarOpen ? "translateX(0)" : "translateX(-100%)",
        }}
      >
        {sidebarContent}
      </div>

      {/* 内容区 */}
      <div className="flex-1 flex flex-col min-h-screen bg-zinc-50 dark:bg-zinc-950 overflow-x-hidden">
        <TopHeader
          pathname={pathname}
          t={t}
          isDark={isDark}
          cycle={cycle}
          mode={mode}
          i18n={i18n}
          toggleLanguage={toggleLanguage}
        />
        <main className="flex-1 p-4 md:p-6 overflow-x-hidden">{children}</main>
      </div>
    </div>
  );
}
