"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { useTranslation } from "react-i18next";
import {
  LayoutDashboard,
  Server,
  Key,
  FileText,
  ScrollText,
  Settings,
  Bell,
  LogOut,
  Menu,
  X,
  ChevronDown,
  ChevronRight,
  BarChart3,
  Zap,
  Download,
  Database,
  Wifi,
  WifiOff,
} from "lucide-react";
import { message } from "antd";
import GlobalLoading from "@/components/Loading";
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
  { key: "dashboard", icon: LayoutDashboard, href: "/admin", group: "overview" },
  { key: "platforms", icon: Server, href: "/admin/platforms", group: "manage" },
  { key: "keys", icon: Key, href: "/admin/keys", group: "manage" },
  { key: "autoModel", icon: Zap, href: "/admin/auto-model", group: "manage" },
  { key: "requestTemplates", icon: FileText, href: "/admin/request-templates", group: "manage" },
  { key: "usage", icon: BarChart3, href: "/admin/usage", group: "monitor" },
  { key: "logs", icon: FileText, href: "/admin/logs", group: "monitor" },
  { key: "audit", icon: ScrollText, href: "/admin/audit", group: "monitor" },
  { key: "events", icon: Bell, href: "/admin/events", group: "monitor" },
  { key: "dataManager", icon: Download, href: "/admin/data-manager", group: "system" },
  { key: "systemKeys", icon: Key, href: "/admin/system-keys", group: "system" },
  { key: "system", icon: Settings, href: "/admin/system", group: "system" },
];

const groupI18nKeys: Record<string, string> = {
  overview: "groupOverview",
  manage: "groupManage",
  monitor: "groupMonitor",
  system: "groupSystem",
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
      onClick={onClick}
      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200 group relative ${
        isActive
          ? "bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 font-medium"
          : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100"
      }`}
    >
      <Icon className="w-5 h-5 shrink-0" />
      <span className="text-sm">{t(item.key)}</span>
      {isActive && (
        <div className="absolute right-2">
          <div className="w-1.5 h-1.5 rounded-full bg-blue-600 dark:bg-blue-400" />
        </div>
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
    <div className="mb-6">
      <button
        onClick={onToggle}
        className="flex items-center gap-2 w-full px-3 py-2 text-xs font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
      >
        {t(groupI18nKeys[group] ?? group)}
        {isCollapsed ? (
          <ChevronRight className="w-3 h-3" />
        ) : (
          <ChevronDown className="w-3 h-3" />
        )}
      </button>
      {!isCollapsed && (
        <div className="mt-2 space-y-1">
          {groupItems.map((item) => (
            <SidebarItem
              key={item.key}
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
  logoutLoading,
  t,
}: {
  username: string;
  onLogout: () => void;
  logoutLoading: boolean;
  t: (key: string) => string;
}) {
  return (
    <div className="mt-auto pt-4 border-t border-zinc-200 dark:border-zinc-800">
      <div className="px-3 py-3 rounded-lg bg-zinc-50 dark:bg-zinc-800/50 mb-3">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-semibold text-sm">
            {username.charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
              {username}
            </div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">{t("administrator")}</div>
          </div>
        </div>
      </div>
      <button
        onClick={onLogout}
        disabled={logoutLoading}
        className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-zinc-600 dark:text-zinc-400 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-600 dark:hover:text-red-400 transition-all disabled:opacity-50"
      >
        <LogOut className="w-5 h-5" />
        <span className="text-sm">{t("logout")}</span>
      </button>
    </div>
  );
}

// ---------- TopHeader ----------
function TopHeader({
  pathname,
  t,
  onToggleSidebar,
}: {
  pathname: string;
  t: (key: string) => string;
  onToggleSidebar: () => void;
}) {
  const breadcrumbMap: Record<string, string> = {
    "/admin": "dashboard",
    "/admin/platforms": "platforms",
    "/admin/platforms/[id]": "platforms",
    "/admin/keys": "keys",
    "/admin/auto-model": "autoModel",
    "/admin/request-templates": "requestTemplates",
    "/admin/usage": "usage",
    "/admin/logs": "logs",
    "/admin/audit": "audit",
    "/admin/system": "system",
    "/admin/events": "events",
    "/admin/data-manager": "dataManager",
    "/admin/system-keys": "systemKeys",
  };

  const breadcrumbKey = breadcrumbMap[pathname] ?? "dashboard";
  const breadcrumb = t(breadcrumbKey);

  return (
    <header className="fixed top-0 left-0 right-0 h-16 bg-white/80 dark:bg-zinc-900/80 backdrop-blur-md border-b border-zinc-200 dark:border-zinc-800 z-40">
      <div className="h-full px-4 lg:pl-64 lg:pr-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button
            onClick={onToggleSidebar}
            className="lg:hidden p-2 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <Menu className="w-5 h-5 text-zinc-600 dark:text-zinc-400" />
          </button>
          <nav className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
            <span className="hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors">
              {t("systemConfig")}
            </span>
            <span className="text-zinc-300 dark:text-zinc-600">›</span>
            <span className="font-medium text-zinc-900 dark:text-zinc-100">{breadcrumb}</span>
          </nav>
        </div>
      </div>
    </header>
  );
}

// ---------- 主布局 ----------
export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { t } = useTranslation("admin");
  const router = useRouter();
  const pathname = router.pathname;
  const [username, setUsername] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [logoutLoading, setLogoutLoading] = useState(false);
  const [healthStatus, setHealthStatus] = useState<{ status: string; dbType: string } | null>(null);

  const isLoginPage = pathname === "/admin/login";

  const open = useCallback(() => setSidebarOpen(true), []);
  const close = useCallback(() => setSidebarOpen(false), []);

  // 修复：添加 AbortController 防止组件卸载后的竞态请求
  useEffect(() => {
    if (isLoginPage) return;

    const controller = new AbortController();
    const checkAuth = async () => {
      try {
        const res = await fetch("/api/admin/auth", { signal: controller.signal });
        if (!res.ok) {
          router.push("/admin/login");
          return;
        }
        const data: Record<string, any> = await res.json();
        if (data.success && data.data?.username) {
          setUsername(data.data.username);
        } else {
          router.push("/admin/login");
        }
      } catch (err) {
        // 忽略 AbortError，其他错误才跳转
        if (err instanceof DOMException && err.name === "AbortError") return;
        router.push("/admin/login");
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };

    checkAuth();
    return () => controller.abort();
  }, [isLoginPage, router]);

  // 获取服务状态
  useEffect(() => {
    if (isLoginPage) return;
    const controller = new AbortController();
    const fetchHealth = async () => {
      try {
        const res = await fetch("/api/health", { signal: controller.signal });
        if (res.ok) {
          const data = (await res.json()) as { status: string; dbType?: string };
          setHealthStatus({ status: data.status, dbType: data.dbType || "D1" });
        }
      } catch {
        // 忽略
      }
    };
    fetchHealth();
    return () => controller.abort();
  }, [isLoginPage]);

  const handleLogout = async () => {
    if (logoutLoading) return;
    setLogoutLoading(true);
    try {
      const res = await fetch("/api/admin/auth", { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      message.success(t("auth:logoutSuccess"));
      router.push("/");
    } catch {
      message.error(t("auth:logoutFailed"));
    } finally {
      setLogoutLoading(false);
    }
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

  // 加载中显示旋转图标
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-zinc-950">
        <GlobalLoading />
      </div>
    );
  }

  const sidebarContent = (
    <div className="flex flex-col h-full bg-white dark:bg-zinc-900 border-r border-zinc-200 dark:border-zinc-800">
      {/* 品牌头 */}
      <div className="h-16 flex items-center gap-3 px-4 border-b border-zinc-200 dark:border-zinc-800">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-bold text-sm">
          FW
        </div>
        <div className="flex flex-col">
          <span className="text-sm font-bold text-zinc-900 dark:text-zinc-100 leading-tight">
            {t("common:brandName")}
          </span>
          <span className="text-xs text-zinc-500 dark:text-zinc-400 leading-tight">
            {t("common:brandSub")}
          </span>
        </div>
      </div>

      {/* 用户信息 */}
      <div className="px-3 py-3">
        <SidebarUserMenu
          username={username}
          onLogout={handleLogout}
          logoutLoading={logoutLoading}
          t={t}
        />
      </div>

      {/* 服务状态 */}
      {healthStatus && (
        <div className="px-3 mb-4">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-50 dark:bg-zinc-800/50 text-xs">
            <div className="flex items-center gap-1.5 flex-1">
              <Database className="w-3.5 h-3.5 text-zinc-400" />
              <span className="text-zinc-600 dark:text-zinc-400">{healthStatus.dbType}</span>
            </div>
            {healthStatus.status === "ok" ? (
              <Wifi className="w-3.5 h-3.5 text-emerald-500" />
            ) : (
              <WifiOff className="w-3.5 h-3.5 text-red-500" />
            )}
          </div>
        </div>
      )}

      {/* 菜单 */}
      <nav className="flex-1 overflow-y-auto px-3 py-4">
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
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      {/* 顶部 Header - 固定高度 64px */}
      <TopHeader pathname={pathname} t={t} onToggleSidebar={open} />

      {/* 桌面端侧边栏 - 固定在左侧，从 Header 下方开始 */}
      <aside className="hidden lg:block fixed top-16 left-0 bottom-0 w-64 z-30">
        {sidebarContent}
      </aside>

      {/* 移动端遮罩层 */}
      {sidebarOpen && (
        <div
          className="lg:hidden fixed inset-0 bg-black/50 z-40"
          onClick={close}
        />
      )}

      {/* 移动端侧边栏 */}
      <aside
        className={`lg:hidden fixed top-0 left-0 bottom-0 w-64 z-50 transform transition-transform duration-300 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {sidebarContent}
        <button
          onClick={close}
          className="absolute top-4 right-4 p-2 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400"
        >
          <X className="w-5 h-5" />
        </button>
      </aside>

      {/* 内容区 - 补偿 Header 高度 64px */}
      <main className="min-h-screen pt-16 lg:pl-64">
        <div className="p-4 lg:p-6">
          {children}
        </div>
      </main>
    </div>
  );
}
