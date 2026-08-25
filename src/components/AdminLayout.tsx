"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { useTranslation } from "react-i18next";
import { AnimatePresence, m } from "motion/react";
import {
  LayoutDashboard,
  Server,
  Key,
  FileText,
  ScrollText,
  LogOut,
  Menu,
  X,
  ChevronDown,
  ChevronRight,
  BarChart3,
  Zap,
  Download,
  Database,
  WifiOff,
  Settings,
  Globe,
  FlaskConical,
} from "lucide-react";
import { message } from "antd";
import "@/lib/i18n";
import { collapseVariants, collapseTransition, slideLeftVariants, slideTransition, pageTransition } from "@/lib/motion";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { LanguageToggle } from "@/components/ui/LanguageToggle";
import { registerDefaultItems, useSidebarItems, type SidebarItem } from "@/lib/sidebar-registry";

// ---------- 类型定义 ----------
// MenuItem 已迁移到 sidebar-registry.ts 的 SidebarItem

// ---------- 菜单配置 ----------
const defaultMenuItems: SidebarItem[] = [
  { key: "dashboard", icon: LayoutDashboard, href: "/admin", group: "overview", order: 1 },
  { key: "platforms", icon: Server, href: "/admin/platforms", group: "manage", order: 2 },
  { key: "keys", icon: Key, href: "/admin/keys", group: "manage", order: 3 },
  { key: "autoModel", icon: Zap, href: "/admin/auto-model", group: "manage", order: 4 },
  { key: "requestTemplates", icon: FileText, href: "/admin/request-templates", group: "manage", order: 5 },
  { key: "usage", icon: BarChart3, href: "/admin/usage", group: "monitor", order: 7 },
  { key: "logs", icon: FileText, href: "/admin/logs", group: "monitor", order: 8 },
  { key: "audit", icon: ScrollText, href: "/admin/audit", group: "monitor", order: 9 },
  { key: "dataManager", icon: Download, href: "/admin/data-manager", group: "system", order: 10 },
  { key: "systemKeys", icon: Key, href: "/admin/system-keys", group: "system", order: 11 },
  { key: "upstreamProxy", icon: Globe, href: "/admin/upstream-proxy", group: "system", order: 12 },
  { key: "settings", icon: Settings, href: "/admin/settings", group: "system", order: 13 },
  { key: "playground", icon: FlaskConical, href: "/admin/playground", group: "manage", order: 6 },
];

// 注册默认菜单项（模块加载时执行一次）
registerDefaultItems(defaultMenuItems);

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
  item: SidebarItem;
  isActive: boolean;
  onClick: () => void;
  t: (key: string) => string;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onClick}
      className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-colors group relative ${
        isActive
          ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-medium"
          : "text-zinc-500 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 hover:text-zinc-900 dark:hover:text-zinc-100"
      }`}
    >
      <Icon className="w-[18px] h-[18px] shrink-0" />
      <span className="text-sm">{t(item.key)}</span>
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
  items: SidebarItem[];
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
        <m.span animate={{ rotate: isCollapsed ? 0 : 180 }} transition={{ duration: 0.2 }}>
          <ChevronDown className="w-3 h-3" />
        </m.span>
      </button>
      <AnimatePresence initial={false}>
        {!isCollapsed && (
          <m.div
            variants={collapseVariants}
            initial="collapsed"
            animate="open"
            exit="collapsed"
            transition={collapseTransition}
            className="overflow-hidden"
          >
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
          </m.div>
        )}
      </AnimatePresence>
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
      <div className="px-3 py-2 mb-1">
        {username ? (
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded-lg bg-zinc-900 dark:bg-zinc-100 flex items-center justify-center text-white dark:text-zinc-900 font-semibold text-xs">
              {username.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                {username}
              </div>
              <div className="text-xs text-zinc-400 dark:text-zinc-500">{t("administrator")}</div>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3" aria-busy="true">
            <div className="w-7 h-7 rounded-lg bg-zinc-200 dark:bg-zinc-700 animate-pulse" />
            <div className="flex-1 space-y-2">
              <div className="h-3.5 w-24 rounded bg-zinc-200 dark:bg-zinc-700 animate-pulse" />
              <div className="h-3 w-16 rounded bg-zinc-200 dark:bg-zinc-700 animate-pulse" />
            </div>
          </div>
        )}
      </div>
      <button
        onClick={onLogout}
        disabled={logoutLoading}
        className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-zinc-500 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors disabled:opacity-50"
      >
        <LogOut className="w-[18px] h-[18px]" />
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
    "/admin/platforms/presets": "platforms",
    "/admin/keys": "keys",
    "/admin/auto-model": "autoModel",
    "/admin/request-templates": "requestTemplates",
    "/admin/usage": "usage",
    "/admin/logs": "logs",
    "/admin/audit": "audit",
    "/admin/data-manager": "dataManager",
    "/admin/system-keys": "systemKeys",
    "/admin/upstream-proxy": "upstreamProxy",
    "/admin/settings": "settings",
    "/admin/upstream-proxy/[id]": "upstreamProxy",
  };

  const breadcrumbKey = breadcrumbMap[pathname] ?? "dashboard";
  const breadcrumb = t(breadcrumbKey);

  return (
    <header className="fixed top-0 left-0 right-0 h-16 bg-white/80 dark:bg-zinc-900/80 backdrop-blur-md border-b border-zinc-200/80 dark:border-zinc-800 z-40">
      <div className="h-full px-4 lg:pl-64 lg:pr-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={onToggleSidebar}
            className="lg:hidden p-2 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <Menu className="w-5 h-5 text-zinc-500 dark:text-zinc-400" />
          </button>
          <nav className="flex items-center gap-1.5 text-sm text-zinc-400 dark:text-zinc-500">
            <Settings className="w-4 h-4 hidden sm:block" />
            <span className="hidden sm:inline">{t("systemConfig")}</span>
            <ChevronRight className="w-3.5 h-3.5 hidden sm:block text-zinc-300 dark:text-zinc-600" />
            <span className="font-medium text-zinc-900 dark:text-zinc-100">{breadcrumb}</span>
          </nav>
        </div>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <LanguageToggle />
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
  const [logoutLoading, setLogoutLoading] = useState(false);
  const [healthStatus, setHealthStatus] = useState<{ status: string; dbType: string } | null>(null);

  const isLoginPage = pathname === "/admin/login";

  const open = useCallback(() => setSidebarOpen(true), []);
  const close = useCallback(() => setSidebarOpen(false), []);

  // 认证检查：与页面渲染并行执行，不再门控整页。
  // 布局立即渲染（顶栏/侧边栏/children 即刻可见），页面自身的数据请求随之并行发起；
  // 认证结果到达后若未通过，再跳转登录页。失败路径全部兜底跳转，避免未认证留白。
  useEffect(() => {
    if (isLoginPage) return;

    const controller = new AbortController();
    // 401 踢出携带当前深链，登录成功后回跳原页面（login 页仅接受 /admin 站内路径）。
    // 用 window.location 而非 router.pathname：后者在动态路由页返回 "/admin/platforms/[id]"
    // 字面量，回跳会落在 id="[id]" 的无效详情页
    const loginWithReturn = () => {
      const returnTo = `${window.location.pathname}${window.location.search}`;
      router.push(`/admin/login?redirect=${encodeURIComponent(returnTo)}`);
    };
    const checkAuth = async () => {
      try {
        const res = await fetch("/api/admin/auth", { signal: controller.signal });
        if (!res.ok) {
          loginWithReturn();
          return;
        }
        const data: Record<string, any> = await res.json();
        if (data.success && data.data?.username) {
          setUsername(data.data.username);
        } else {
          loginWithReturn();
        }
      } catch (err) {
        // 忽略 AbortError，其他错误才跳转
        if (err instanceof DOMException && err.name === "AbortError") return;
        loginWithReturn();
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

  // 移动端侧边栏打开期间锁定背景滚动
  useEffect(() => {
    if (!sidebarOpen) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [sidebarOpen]);

  const handleLogout = async () => {
    if (logoutLoading) return;
    setLogoutLoading(true);
    try {
      const res = await fetch("/api/admin/auth", { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      message.success(t("auth:logoutSuccess"));
      router.push("/");
    } catch (err) {
      // 会话已过期（401）时登出目的本就是离开页面：跳登录页而非报错停留，
      // 与数据请求路径的 401 行为一致
      if (err instanceof Error && err.message === "HTTP 401") {
        router.push("/admin/login");
        return;
      }
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

  const sidebarItems = useSidebarItems();

  const grouped = sidebarItems.reduce<Record<string, SidebarItem[]>>((acc, item) => {
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
    <div className="flex flex-col h-full bg-white dark:bg-zinc-900 border-r border-zinc-200 dark:border-zinc-800">
      {/* 品牌头 */}
      <div className="h-16 flex items-center gap-2.5 px-4 border-b border-zinc-200 dark:border-zinc-800">
        <div className="w-7 h-7 rounded-lg bg-zinc-900 dark:bg-zinc-100 flex items-center justify-center text-white dark:text-zinc-900 font-bold text-xs">
          FW
        </div>
        <div className="flex flex-col">
          <span className="text-sm font-bold text-zinc-900 dark:text-zinc-100 leading-tight">
            {t("common:brandName")}
          </span>
          <span className="text-xs text-zinc-400 dark:text-zinc-500 leading-tight">
            {t("common:brandSub")}
          </span>
        </div>
      </div>

      {/* 服务状态 */}
      {healthStatus && (
        <div className="px-3 py-2.5">
          <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-zinc-50 dark:bg-zinc-800/50 text-xs">
            <div className="flex items-center gap-1.5 flex-1">
              <Database className="w-3.5 h-3.5 text-zinc-400" />
              <span className="text-zinc-500 dark:text-zinc-400">{healthStatus.dbType}</span>
            </div>
            {healthStatus.status === "ok" ? (
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
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

      {/* 用户信息 — 置于导航之后，mt-auto 吸底 */}
      <SidebarUserMenu
        username={username}
        onLogout={handleLogout}
        logoutLoading={logoutLoading}
        t={t}
      />
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

      {/* 移动端遮罩层 — 低于顶栏（z-40），顶栏保持可操作；高于内容 */}
      <AnimatePresence>
        {sidebarOpen && (
          <m.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="lg:hidden fixed inset-0 bg-black/50 z-[35]"
            onClick={close}
          />
        )}
      </AnimatePresence>

      {/* 移动端侧边栏 */}
      <AnimatePresence>
        {sidebarOpen && (
          <m.aside
            variants={slideLeftVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={slideTransition}
            className="lg:hidden fixed top-0 left-0 bottom-0 w-64 z-50"
            style={{ boxShadow: "var(--shadow-lg)" }}
          >
            {sidebarContent}
            <button
              onClick={close}
              className="absolute top-4 right-4 p-2 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400"
            >
              <X className="w-5 h-5" />
            </button>
          </m.aside>
        )}
      </AnimatePresence>

      {/* 内容区 - 补偿 Header 高度 64px */}
      <main className="min-h-screen pt-16 lg:pl-64">
        <div className="p-4 lg:p-6">
          <AnimatePresence mode="wait">
            <m.div
              key={router.asPath}
              initial="initial"
              animate="animate"
              exit="exit"
              variants={pageTransition}
            >
              {children}
            </m.div>
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}
