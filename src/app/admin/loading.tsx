import GlobalLoading from '@/components/Loading';

/** 管理后台根级加载状态（Suspense fallback） */
export default function AdminLoading() {
  return <GlobalLoading size="large" />;
}
