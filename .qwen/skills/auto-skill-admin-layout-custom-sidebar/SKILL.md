---
name: admin-layout-custom-sidebar
description: 管理后台自定义侧边栏+顶栏布局模式（参考 ZhouZBoss-Web），替代 antd Layout/Sider/Menu
source: auto-skill
extracted_at: '2026-06-26T13:06:52.123Z'
---

# 管理后台自定义侧边栏+顶栏布局

## 背景
antd 的 `Layout.Sider` + `Menu` 组件在 Next.js App Router 中存在 z-index 层叠冲突、移动端适配差、深色模式覆盖困难等问题。参考 ZhouZBoss-Web 项目，使用自定义侧边栏 + 顶栏模式替代。

## 布局结构
```
<div className="flex min-h-screen overflow-x-hidden">
  <MobileToggle />          {/* 移动端汉堡按钮 */}
  <div className="hidden md:flex w-[280px] min-h-screen z-[100] bg-white dark:bg-zinc-900 flex-col shrink-0">
    <SidebarHeader />       {/* 品牌头：logo + 名称 */}
    <SidebarUserMenu />     {/* 用户信息：头像 + 用户名 + 退出 */}
    <nav className="flex-1 overflow-y-auto px-3 py-6 space-y-7 custom-scrollbar">
      <SidebarGroup />      {/* 菜单分组：标题 + 折叠箭头 + 菜单项列表 */}
    </nav>
  </div>
  {sidebarOpen && <Overlay />}  {/* 移动端遮罩层 */}
  <DrawerSidebar />         {/* 移动端抽屉侧边栏 */}
  <div className="flex-1 flex flex-col min-h-screen bg-zinc-50 dark:bg-zinc-950 overflow-x-hidden">
    <TopHeader />           {/* 面包屑导航 + 暗色模式切换 + 语言切换 */}
    <main className="flex-1 p-4 md:p-6 overflow-x-hidden">{children}</main>
  </div>
</div>
```

## 核心组件

### SidebarItem
- 使用 `lucide-react` 图标（不是 antd icons）
- 三种状态：active（深色背景+白字）、inactive（灰色文字）、hover（高亮）
- active 状态右侧有竖条指示器 `w-1 h-4 bg-white/20 rounded-full`

### SidebarGroup
- 分组标题：`text-[10px] font-black uppercase tracking-[0.2em] text-zinc-300`
- 折叠箭头：`ChevronDown`，折叠时旋转 `-rotate-90`

### SidebarUserMenu
- 白色卡片：`p-2.5 rounded-2xl bg-white border border-zinc-100 shadow-sm`
- 用户名 + 角色标签 + 退出按钮

### MobileToggle
- 固定定位：`fixed top-6 left-6 z-[9999]`
- 仅移动端显示：`md:hidden`
- 汉堡/关闭切换：`Menu` / `X` 图标

### TopHeader
- 面包屑：控制台 > 当前页面
- 右侧：暗色模式切换 + 语言切换
- 使用 `usePathname()` 匹配当前路由

## 菜单配置模式
```typescript
interface MenuItem {
  key: string;        // i18n 翻译键
  icon: React.ElementType;  // lucide-react 图标组件
  href: string;       // 路由路径
  group: string;      // 分组标识
}

// 按 group 分组渲染
const grouped = menuItems.reduce<Record<string, MenuItem[]>>((acc, item) => {
  acc[item.group] ??= [];
  acc[item.group].push(item);
  return acc;
}, {});
```

## 深色模式
- 使用 class 控制：`<html className={isDark ? "dark" : ""}>`
- 侧边栏暗色：`dark:bg-zinc-900`、`dark:border-zinc-800`
- 菜单项暗色：`dark:text-zinc-400`、`dark:hover:bg-zinc-800`
- active 暗色：`dark:bg-zinc-100 dark:text-zinc-900 dark:shadow-zinc-400/20`

## 移动端适配
- 桌面端（`md` 以上）：侧边栏常驻 280px
- 移动端（`md` 以下）：汉堡按钮 → 抽屉侧边栏 300px + 遮罩层
- 侧边栏关闭时 `transform: translateX(-100%)`，打开时 `translateX(0)`

## 关键 CSS
```css
/* 自定义滚动条 */
.custom-scrollbar::-webkit-scrollbar { width: 4px; }
.custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
.custom-scrollbar::-webkit-scrollbar-thumb { background: rgb(209 213 219); border-radius: 2px; }
.dark .custom-scrollbar::-webkit-scrollbar-thumb { background: rgb(63 63 70); }
```

## 禁止事项
- 不要使用 antd `Layout.Sider`、`Layout.Menu`、`Layout.Header`、`Layout.Content`
- 不要使用 `@ant-design/icons`
- 使用 `lucide-react` 图标
- 使用 `tailwindcss` 类名实现样式
