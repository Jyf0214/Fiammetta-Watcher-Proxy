'use client';

import { useState, useEffect, useMemo, useCallback, type ReactNode } from 'react';
// @lobehub/ui 没有 Table / Pagination 组件，保留 antd
import { Table, Pagination } from 'antd';
import type { TableProps } from 'antd';

/**
 * 精简列类型 — 只包含 ResponsiveTable 实际使用的属性，
 * 避免 antd ColumnGroupType 联合类型导致 dataIndex 等属性不可访问。
 */
type Col<T> = {
  key?: string | number;
  dataIndex?: string | string[];
  responsive?: string[];
  title?: ReactNode;
  width?: number;
  align?: 'left' | 'center' | 'right';
  ellipsis?: boolean;
  fixed?: 'left' | 'right';
  render?: (value: unknown, record: T, index: number) => ReactNode;
};

/* ── 断点映射（与 antd responsive 一致） ── */
const BP: Record<string, number> = {
  xs: 0,
  sm: 640,
  md: 768,
  lg: 992,
  xl: 1200,
  xxl: 1600,
};

/* ── 响应式屏幕宽度检测 ── */
function useScreenWidth() {
  const [w, setW] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1024,
  );
  useEffect(() => {
    const h = () => setW(window.innerWidth);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);
  return w;
}

/* ── 列在当前宽度下是否可见 ── */
function colVisible<T>(col: Col<T>, sw: number): boolean {
  if (!col.responsive) return true;
  return col.responsive.some((bp: string) => sw >= (BP[bp] ?? 0));
}

/* ── 提取单元格内容 ── */
function cellOf<T>(col: Col<T>, record: T, idx: number): ReactNode {
  const val =
    typeof col.dataIndex === 'string'
      ? (record as Record<string, unknown>)[col.dataIndex]
      : undefined;
  if (col.render) return col.render(val, record, idx) as ReactNode;
  if (val != null && val !== '') return String(val);
  return '\u2014';
}

/* ── 移动端卡片列表 ── */
function MobileCards<T>({
  data,
  columns,
  rowKey,
}: {
  data: readonly T[];
  columns: Col<T>[];
  rowKey: string | number | ((r: T) => string);
}) {
  const sw = useScreenWidth();

  const { titleCol, bodyCols, actionsCol } = useMemo(() => {
    const vis = columns.filter((c) => colVisible(c, sw));
    const t = vis.find((c) => c.key !== 'actions' && c.dataIndex);
    const a = vis.find((c) => c.key === 'actions');
    const b = vis.filter((c) => c !== t && c !== a);
    return { titleCol: t, bodyCols: b, actionsCol: a };
  }, [columns, sw]);

  const keyOf = useCallback(
    (r: T) => {
      if (typeof rowKey === 'function') return rowKey(r);
      return String((r as Record<string, unknown>)[String(rowKey)]);
    },
    [rowKey],
  );

  if (!data.length) {
    return (
      <div className="text-center py-12 text-sm text-zinc-400 dark:text-zinc-500">
        暂无数据
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {data.map((r, i) => (
        <div
          key={keyOf(r)}
          className="rounded-2xl border border-zinc-100 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 shadow-sm"
        >
          {/* 卡片头部：标题 + 操作按钮 */}
          <div className="flex items-center justify-between mb-3 pb-2 border-b border-zinc-50 dark:border-zinc-800/50">
            <div className="font-semibold text-sm text-zinc-900 dark:text-zinc-100 truncate flex-1 mr-2">
              {titleCol ? cellOf(titleCol, r, i) : keyOf(r)}
            </div>
            {actionsCol && (
              <div className="flex items-center gap-1 shrink-0">
                {cellOf(actionsCol, r, i)}
              </div>
            )}
          </div>
          {/* 卡片内容：标签-值网格 */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
            {bodyCols.map((c) => (
              <div key={String(c.key ?? c.dataIndex)}>
                <div className="text-[11px] font-medium text-zinc-400 dark:text-zinc-500 mb-0.5 leading-tight">
                  {typeof c.title === 'string' ? c.title : String(c.key ?? '')}
                </div>
                <div className="text-sm text-zinc-700 dark:text-zinc-300 break-words leading-snug">
                  {cellOf(c, r, i)}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── 移动端检测 Hook ── */
function useIsMobile() {
  const [m, setM] = useState(false);
  useEffect(() => {
    const q = window.matchMedia('(max-width: 767px)');
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setM(q.matches);
    const h = (e: MediaQueryListEvent) => setM(e.matches);
    q.addEventListener('change', h);
    return () => q.removeEventListener('change', h);
  }, []);
  return m;
}

/* ── 加载指示器 ── */
function MobileSpinner() {
  return (
    <div className="flex justify-center py-12">
      <div className="w-6 h-6 border-2 border-zinc-200 dark:border-zinc-700 border-t-zinc-500 dark:border-t-zinc-400 rounded-full animate-spin" />
    </div>
  );
}

/* ═══════════════════════════════════════════════
 * ResponsiveTable — 桌面端渲染 antd Table，移动端渲染卡片列表或时间线
 *
 * 接受与 antd Table 完全相同的 props，移动端自动将每行数据
 * 渲染为独立卡片，按 responsive 断点控制列的显隐。
 *
 * timeline 模式：移动端渲染紧凑时间线（圆点+竖线+消息+时间），
 * 适用于事件日志等高密度列表。
 * ═══════════════════════════════════════════════ */

/** 时间线模式专用字段映射 */
interface TimelineFieldMap<T> {
  level: keyof T & string;
  message: keyof T & string;
  time: keyof T & string;
}

const LEVEL_DOT: Record<string, string> = {
  info: "bg-blue-500",
  warning: "bg-amber-500",
  error: "bg-red-500",
  critical: "bg-red-600",
};

function TimelineView<T>({
  data,
  fields,
  rowKey,
}: {
  data: readonly T[];
  fields: TimelineFieldMap<T>;
  rowKey: string | number | ((r: T) => string);
}) {
  const keyOf = useCallback(
    (r: T) => {
      if (typeof rowKey === "function") return rowKey(r);
      return String((r as Record<string, unknown>)[String(rowKey)]);
    },
    [rowKey],
  );

  if (!data.length) {
    return (
      <div className="text-center py-8 text-sm text-zinc-400">暂无事件</div>
    );
  }

  return (
    <div className="relative">
      <div className="absolute left-[7px] top-1 bottom-1 w-px bg-zinc-200 dark:bg-zinc-700" />
      <div className="space-y-3">
        {data.map((r) => {
          const level = String((r as Record<string, unknown>)[fields.level] ?? "");
          const msg = String((r as Record<string, unknown>)[fields.message] ?? "");
          const rawTime = (r as Record<string, unknown>)[fields.time];
          const d = new Date(rawTime as string | number);
          const timeStr = `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
          return (
            <div key={keyOf(r)} className="relative flex items-start gap-3 pl-0">
              <div className={`relative z-10 mt-1.5 h-[10px] w-[10px] rounded-full ${LEVEL_DOT[level] || "bg-zinc-400"} ring-2 ring-white dark:ring-zinc-900 shrink-0`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm text-zinc-800 dark:text-zinc-200 truncate">{msg}</span>
                  <span className="text-[11px] text-zinc-400 shrink-0 tabular-nums">{timeStr}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ResponsiveTable<T>(
  props: TableProps<T> & {
    timeline?: boolean;
    timelineFields?: TimelineFieldMap<T>;
  },
) {
  const {
    columns = [],
    dataSource,
    rowKey = 'id',
    pagination,
    loading,
    scroll,
    timeline,
    timelineFields,
    ...rest
  } = props;

  const isMobile = useIsMobile();

  // ── 移动端：时间线模式 ──
  if (isMobile && timeline && timelineFields) {
    return (
      <div>
        {loading ? (
          <MobileSpinner />
        ) : (
          <TimelineView
            data={dataSource ?? []}
            fields={timelineFields}
            rowKey={rowKey as string | number | ((r: T) => string)}
          />
        )}
      </div>
    );
  }

  // ── 移动端：卡片列表 ──
  if (isMobile) {
    return (
      <div>
        {loading ? (
          <MobileSpinner />
        ) : (
          <MobileCards
            data={dataSource ?? []}
            columns={columns as Col<T>[]}
            rowKey={rowKey as string | number | ((r: T) => string)}
          />
        )}
        {pagination !== false && pagination && (
          <div className="mt-4 flex justify-center">
            <Pagination
              {...(typeof pagination === 'object' ? pagination : {})}
              size="small"
            />
          </div>
        )}
      </div>
    );
  }

  // ── 桌面端：标准表格 ──
  return (
    <div className="overflow-x-auto">
      <Table
        columns={columns}
        dataSource={dataSource}
        rowKey={rowKey}
        pagination={pagination}
        loading={loading}
        scroll={scroll}
        {...rest}
      />
    </div>
  );
}
