import { Skeleton } from "@/components/ui/Skeleton";
import { SurfaceSkeleton, type SurfaceSkeletonVariant } from "@/components/ui/SurfaceSkeleton";
import { useTranslation } from "react-i18next";
import { m } from "motion/react";
import { useRouter } from "next/router";

/** 根据路由路径选择骨架屏 variant */
function getVariant(pathname: string): SurfaceSkeletonVariant {
  // 平台管理页为紧凑分组行列表（max-w-2xl），非卡片网格——骨架按 list 渲染
  // 避免加载完成时从满宽三列大卡跳变为窄列表
  if (pathname.startsWith("/admin/platforms")) return "list";
  if (pathname.startsWith("/admin/keys") || pathname.startsWith("/admin/system-keys")) return "list";
  if (pathname.startsWith("/admin/request-templates")) return "list";
  if (pathname.startsWith("/admin/auto-model")) return "list";
  if (pathname.startsWith("/admin/usage") || pathname.startsWith("/admin/logs") || pathname.startsWith("/admin/audit")) return "list";
  if (pathname.startsWith("/admin/data-manager")) return "form";
  return "list";
}

/**
 * 路由切换骨架屏 — 管理后台页面切换时替代白屏/居中 Spinner
 *
 * 布局与 AdminLayout 对齐：顶栏 + 标题区 + 统计卡片网格 + 列表块，
 * 淡入过渡，避免页面切换闪烁。
 */
export default function RouteLoading() {
  const { t } = useTranslation("common");
  const router = useRouter();
  const variant = getVariant(router.pathname);

  // z-20 低于桌面侧边栏(z-30)/顶栏(z-40)/移动抽屉(z-50)：
  // 导航过渡期间侧边栏与顶栏保持稳定可见，仅内容区被骨架屏覆盖；
  // 内部的假顶栏骨架会被真顶栏（z-40）覆盖，无视觉冲突
  return (
    <m.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 z-20 bg-zinc-50 dark:bg-zinc-950 overflow-hidden"
      role="status"
      aria-label={t("loading")}
    >
      {/* 顶栏占位 — 真顶栏为半透明 + backdrop-blur，此处只铺纯色底；
          画骨架块会以模糊残影透出在面包屑文字后方 */}
      <div className="h-16 bg-white dark:bg-zinc-900 border-b border-zinc-200/80 dark:border-zinc-800" />

      {/* 内容骨架 — 与 AdminLayout main 的 pt-16 lg:pl-64、p-4 lg:p-6 对齐 */}
      <div className="pt-16 lg:pl-64">
        <div className="p-4 lg:p-6 space-y-5 max-w-6xl mx-auto">
          {/* 标题区 */}
          <div className="flex items-center gap-3">
            <Skeleton className="h-9 w-9 rounded-lg" />
            <div className="space-y-2">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-3 w-52" />
            </div>
          </div>

          {/* 根据路由匹配骨架 variant */}
          <SurfaceSkeleton variant={variant} showHeader />
        </div>
      </div>
    </m.div>
  );
}
