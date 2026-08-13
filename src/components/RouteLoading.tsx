import { Skeleton } from "@/components/ui/Skeleton";
import { useTranslation } from "react-i18next";
import { m } from "motion/react";

/**
 * 路由切换骨架屏 — 管理后台页面切换时替代白屏/居中 Spinner
 *
 * 布局与 AdminLayout 对齐：顶栏 + 标题区 + 统计卡片网格 + 列表块，
 * 淡入过渡，避免页面切换闪烁。
 */
export default function RouteLoading() {
  const { t } = useTranslation("common");
  return (
    <m.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 z-[200] bg-zinc-50 dark:bg-zinc-950 overflow-hidden"
      role="status"
      aria-label={t("loading")}
    >
      {/* 顶栏骨架 — 与 TopHeader 一致：移动端全宽、桌面端从侧边栏（64 = 16rem）右侧开始 */}
      <div className="h-16 bg-white dark:bg-zinc-900 border-b border-zinc-200/80 dark:border-zinc-800 flex items-center px-4 lg:pl-64 lg:pr-6">
        <Skeleton className="h-4 w-28" />
      </div>

      {/* 内容骨架 — 与 AdminLayout main 的 pt-16 lg:pl-64、p-4 lg:p-6 对齐 */}
      <div className="pt-16 lg:pl-64">
        <div className="p-4 lg:p-6 space-y-5 max-w-[1400px] mx-auto">
          {/* 标题区 */}
          <div className="flex items-center gap-3">
            <Skeleton className="h-9 w-9 rounded-lg" />
            <div className="space-y-2">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-3 w-52" />
            </div>
          </div>

          {/* 统计卡片网格 */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-20 rounded-xl bg-white dark:bg-zinc-900" />
            ))}
          </div>

          {/* 列表块 */}
          <Skeleton className="h-72 rounded-xl bg-white dark:bg-zinc-900" />
        </div>
      </div>
    </m.div>
  );
}
