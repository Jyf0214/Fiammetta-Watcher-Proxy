---
name: ui-layer-stacking-fixes
description: Next.js + antd 项目中 z-index 层叠冲突、移动端适配、深色模式的系统化修复方案
source: auto-skill
extracted_at: '2026-06-21T00:36:22.041Z'
---

# UI 层次问题系统化修复方案

## 问题背景

Next.js + antd + TailwindCSS 项目中常见的 UI 层次问题：
1. z-index 层叠冲突（侧边栏遮挡弹窗）
2. 移动端内容溢出（表格、表单、导航）
3. 深色模式下 antd 组件样式异常

## 修复策略

### 1. z-index 层叠上下文

**antd 组件默认 z-index**：
```
Sider: auto (无显式 z-index)
Modal: 1000
Drawer: 1000
Popover: 1030
Tooltip: 1070
Dropdown: 1050
```

**修复方法**：在 globals.css 中统一定义：

```css
/* 移动端侧边栏固定定位 */
@media (max-width: 768px) {
  .ant-layout-sider {
    position: fixed !important;
    z-index: 100;
    height: 100vh;
  }
}

/* 确保弹窗高于侧边栏 */
.ant-modal-root {
  z-index: 1000;
}
```

### 2. 移动端适配清单

**登录页**：
```tsx
// ❌ 固定宽度溢出
<Card className="w-96">

// ✅ 响应式宽度
<Card className="w-full max-w-96">
<div className="px-4">  {/* 外层 padding */}
```

**管理后台侧边栏**：
```tsx
// 自动检测屏幕宽度并折叠
useEffect(() => {
  const handleResize = () => {
    if (window.innerWidth < 768) setCollapsed(true);
  };
  handleResize();
  window.addEventListener("resize", handleResize);
  return () => window.removeEventListener("resize", handleResize);
}, []);
```

**Header 按钮**：
```tsx
// 小屏隐藏文字，只显示图标
<Button icon={<GlobalOutlined />} size="small">
  <span className="hidden md:inline">中文</span>
</Button>
```

**表格溢出**：
```tsx
// 包裹 Table 的容器添加滚动
<div className="overflow-x-auto">
  <Table columns={columns} dataSource={data} />
</div>
```

**弹窗响应式**：
```tsx
<Modal
  width="90%"  // 移动端全宽
  style={{ maxWidth: 520 }}  // 桌面端限制宽度
>
```

### 3. 深色模式修复

**globals.css 添加 antd 深色覆盖**：

```css
@media (prefers-color-scheme: dark) {
  /* Card 背景 */
  .ant-card {
    background-color: #1f2937;
    border-color: #374151;
  }

  /* Table */
  .ant-table {
    background-color: #1f2937;
  }
  .ant-table-thead > tr > th {
    background-color: #111827;
    color: #e5e7eb;
  }
  .ant-table-tbody > tr > td {
    border-color: #374151;
  }

  /* Input */
  .ant-input, .ant-input-affix-wrapper {
    background-color: #1f2937;
    border-color: #374151;
    color: #e5e7eb;
  }

  /* Menu */
  .ant-menu-dark {
    background-color: #111827;
  }

  /* Modal */
  .ant-modal-content {
    background-color: #1f2937;
  }
}
```

**或使用 antd ConfigProvider**：
```tsx
<ConfigProvider
  theme={{
    token: {
      colorBgContainer: '#1f2937',
      colorBorder: '#374151',
      colorText: '#e5e7eb',
    },
  }}
>
```

### 4. viewport 配置

Next.js 16 根布局必须配置 viewport：

```tsx
import type { Metadata, Viewport } from "next";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,  // 防止移动端缩放
};
```

### 5. 验证清单

```bash
# TypeScript 检查
npx tsc --noEmit

# 构建验证
npm run build

# 移动端测试（Chrome DevTools → Toggle Device Toolbar）
# - 375px (iPhone SE)
# - 390px (iPhone 14)
# - 768px (iPad)
```

## 决策矩阵

| 问题 | 修复位置 | 优先级 |
|------|---------|--------|
| z-index 冲突 | globals.css | 高 |
| 登录页溢出 | page.tsx | 高 |
| 侧边栏遮挡 | layout.tsx + globals.css | 高 |
| 表格溢出 | 各 admin 页面 | 中 |
| 弹窗溢出 | globals.css | 中 |
| 深色模式 | globals.css 或 ConfigProvider | 低 |
| Header 溢出 | layout.tsx | 低 |
