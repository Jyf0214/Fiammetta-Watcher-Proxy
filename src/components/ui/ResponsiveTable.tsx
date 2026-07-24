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

/** 将 ISO 时间格式化为 HH:MM:SS */
function formatTimeOnly(raw: string | number): string {
  const d = new Date(raw);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
}

/** 将 ISO 时间格式化为 MM-DD */
function formatDateOnly(raw: string | number): string {
  const d = new Date(raw);
  return `${(d.getMonth() + 1).toString().padStart(2, "0")}-${d.getDate().toString().padStart(2, "0")}`;
}

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

  // 按日期分组 + 连续重复事件折叠
  const groups: Record<string, Array<{ id: string; level: string; message: string; time: string; count: number }>> = {};
  let lastKey = "";
  for (const r of data) {
    const rawTime = (r as Record<string, unknown>)[fields.time];
    const date = formatDateOnly(rawTime as string | number);
    const time = formatTimeOnly(rawTime as string | number);
    const msg = String((r as Record<string, unknown>)[fields.message] ?? "");
    const level = String((r as Record<string, unknown>)[fields.level] ?? "");
    const id = keyOf(r);
    const dedupKey = `${date}|||${msg}`;
    if (dedupKey === lastKey) {
      const g = groups[date];
      if (g.length > 0) g[g.length - 1].count++;
    } else {
      if (!groups[date]) groups[date] = [];
      groups[date].push({ id, level, message: msg, time, count: 1 });
      lastKey = dedupKey;
    }
  }

  const dateEntries = Object.entries(groups);

  return (
    <div>
      {dateEntries.map(([date, items]) => (
        <div key={date}>
          {/* 日期分隔线 */}
          <div className="flex items-center gap-2 my-3 first:mt-0">
            <span className="text-[11px] font-medium text-zinc-400 bg-white dark:bg-zinc-900 px-1.5 relative z-10">
              {date}
            </span>
            <div className="flex-1 h-px bg-zinc-100 dark:bg-zinc-800" />
          </div>
          {/* 事件列表 + 竖线 */}
          <div className="relative pl-3">
            <div className="absolute left-[5px] top-1 bottom-1 w-px bg-zinc-200 dark:bg-zinc-700" />
            <div className="space-y-2.5">
              {items.map((item) => (
                <div key={item.id} className="relative flex items-start gap-2.5">
                  <div className={`relative z-10 mt-[5px] h-[8px] w-[8px] rounded-full ${LEVEL_DOT[item.level] || "bg-zinc-400"} ring-2 ring-white dark:ring-zinc-900 shrink-0`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm text-zinc-800 dark:text-zinc-200 truncate">
                        {item.message}
                        {item.count > 1 && (
                          <span className="text-xs text-zinc-400 ml-1">({item.count}次)</span>
                        )}
                      </span>
                      <span className="text-[11px] text-zinc-400 shrink-0 tabular-nums">{item.time}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ))}
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
