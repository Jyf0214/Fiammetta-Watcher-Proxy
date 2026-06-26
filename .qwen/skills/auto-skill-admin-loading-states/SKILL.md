---
name: admin-loading-states
description: 管理后台加载状态统一方案：GlobalLoading 组件 + Next.js loading.tsx + 页面级加载
source: auto-skill
extracted_at: '2026-06-26T14:52:13.580Z'
---

## 管理后台加载状态统一方案

### 核心原则

1. **禁止使用 antd Spin** — 改用 lucide-react Loader2 + tailwindcss animate-spin
2. **每个 admin 子路由必须有 loading.tsx** — Next.js Suspense 约定
3. **布局层认证加载** — checkAuth 期间显示全屏 Loader2
4. **页面级数据加载** — 初始数据未到达时显示 GlobalLoading
5. **Table loading prop** — 保留 antd Table 自带的行内加载效果

### GlobalLoading 组件

位置：`src/components/Loading/index.tsx`

```tsx
"use client";
import { Loader2 } from "lucide-react";

interface GlobalLoadingProps {
  size?: "small" | "default" | "large";
  tip?: string;
}

const sizeMap = { small: 16, default: 24, large: 40 };
const textSizeMap = { small: "text-xs", default: "text-sm", large: "text-base" };

export default function GlobalLoading({ size = "large", tip }: GlobalLoadingProps) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[200px] gap-3">
      <Loader2 size={sizeMap[size]} className="animate-spin text-zinc-300 dark:text-zinc-600" />
      {tip && <span className={`${textSizeMap[size]} text-zinc-400 dark:text-zinc-500`}>{tip}</span>}
    </div>
  );
}
```

### loading.tsx 模板

每个 admin 子路由目录下创建 `loading.tsx`：

```tsx
import GlobalLoading from "@/components/Loading";
export default function Loading() {
  return <GlobalLoading size="large" />;
}
```

需要创建的目录：
- `src/app/admin/loading.tsx`（根级）
- `src/app/admin/platforms/loading.tsx`
- `src/app/admin/keys/loading.tsx`
- `src/app/admin/models/loading.tsx`
- `src/app/admin/logs/loading.tsx`
- `src/app/admin/audit/loading.tsx`
- `src/app/admin/events/loading.tsx`
- `src/app/admin/system/loading.tsx`

### 布局层认证加载

在 `admin/layout.tsx` 中：

```tsx
const [loading, setLoading] = useState(true);

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
  } finally {
    setLoading(false);
  }
};

// 在 isLoginPage 检查之后、渲染侧边栏之前
if (loading) {
  return (
    <div className="flex items-center justify-center min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <Loader2 size={32} className="animate-spin text-zinc-300 dark:text-zinc-600" />
    </div>
  );
}
```

### 页面级数据加载

在每个 admin 页面中，初始数据加载时显示 GlobalLoading：

```tsx
if (loading && data.length === 0) {
  return <GlobalLoading size="large" />;
}
```

### 按钮加载状态

使用 `LoadingSpinner` 组件（`src/components/ui/Button/LoadingSpinner.tsx`）：

```tsx
import { LoadingSpinner } from "@/components/ui/Button/LoadingSpinner";

// 在按钮中
{loading ? <LoadingSpinner /> : <span>提交</span>}
```

### 禁止模式

- ❌ `<Spin size="large" />` — 使用 GlobalLoading
- ❌ 内联 CSS spinner — 使用 LoadingSpinner 组件
- ❌ 无加载状态的页面 — 必须有 loading.tsx 或页面级加载
