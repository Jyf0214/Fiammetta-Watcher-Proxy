---
name: nextjs-layout-hooks
description: Next.js App Router Layout 中 React hooks 无条件调用规则与条件渲染模式
source: auto-skill
extracted_at: '2026-06-21T02:00:00.000Z'
---

## 问题

Next.js App Router 中，Layout 组件经常需要对某些子页面（如登录页）跳过侧边栏/导航栏等包裹逻辑。常见的错误做法是在组件顶部做 early return，导致部分 hooks 被条件性跳过，违反 React hooks 规则。

## 错误模式

```tsx
export default function AdminLayout({ children }) {
  const pathname = usePathname();
  const [state, setState] = useState(null);

  // ❌ 违反 hooks 规则：early return 在 useEffect 之前
  if (pathname === "/admin/login") {
    return <>{children}</>;
  }

  useEffect(() => {
    // 这个 useEffect 在登录页不会被调用
  }, []);

  return <Layout>{children}</Layout>;
}
```

React 要求每次渲染时 hooks 的调用顺序必须完全一致。条件性 early return 会导致 hooks 在某些渲染中被跳过，造成状态错乱或崩溃。

## 正确模式

```tsx
export default function AdminLayout({ children }) {
  const pathname = usePathname();
  const [state, setState] = useState(null);
  const isLoginPage = pathname === "/admin/login";

  // ✅ 所有 hooks 无条件调用
  useEffect(() => {
    if (isLoginPage) return; // 在 effect 内部做条件判断
    fetchData();
  }, [isLoginPage]);

  // ✅ early return 放在所有 hooks 之后、JSX return 之前
  if (isLoginPage) {
    return <>{children}</>;
  }

  return <Layout>{children}</Layout>;
}
```

## 规则

1. **所有 hooks 必须无条件调用** — `useState`、`useEffect`、`useContext`、自定义 hooks 等必须在每次渲染中按相同顺序执行
2. **early return 只能放在所有 hooks 之后** — 在 hooks 调用完毕、普通变量声明完毕之后，才能做条件性返回
3. **effect 内部的条件判断是安全的** — `useEffect(() => { if (condition) return; ... }, [condition])` 是合法的条件逻辑
4. **不要把 early return 放在 hooks 之间** — 即使某些 hooks 在特定路径下"不需要"，也必须调用

## 适用场景

- Layout 组件需要对特定路由跳过导航/侧边栏
- 页面组件根据权限条件性渲染
- 任何 "部分路由使用不同布局" 的 App Router 模式
