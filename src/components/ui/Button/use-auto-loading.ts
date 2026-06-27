'use client';

import { useState, useCallback, useRef, useEffect } from 'react';

/**
 * 按钮自动加载状态管理 Hook
 *
 * - autoLoading 默认开启：点击后自动进入加载，按钮变淡且不可重复点击
 * - 若 onClick 返回 Promise，加载状态在 Promise 完成后自动解除
 * - loading prop 传入时进入受控模式，autoLoading 不生效
 *
 * 注意：内部使用 `runWithMinLoadingDuration` 保证 loading 状态至少保持
 * `MIN_LOADING_DURATION_MS` 毫秒，避免同步 onClick 在同一微任务内
 * setLoading(true) / setLoading(false) 被 React 合并掉、用户根本看不到 spinner。
 */

/** 加载动画最小显示时长：保证用户能感知到旋转图标，而不是一闪而过 */
export const MIN_LOADING_DURATION_MS = 400;

/**
 * 以「最小显示时长」为约束执行一个动作，期间持续触发 loading 状态。
 *
 * - 抽出为纯函数便于在 node 测试环境中独立验证（无需 react-testing-library）
 * - 若 action 是同步或耗时 < minMs，会用 setTimeout 补足剩余时间
 * - 若 action 是异步且耗时 >= minMs，则在 action 完成后立即解除 loading
 *
 * @param setLoading 控制 loading 状态的 setter
 * @param action 要执行的动作（可以返回 Promise；返回 void 也可）
 * @param minMs 最小显示时长（毫秒）
 * @param timerRef 可选：用于追踪 setTimeout ID，以便卸载时清理
 */
export function runWithMinLoadingDuration(
  setLoading: (loading: boolean) => void,
  action: () => void | Promise<unknown>,
  minMs: number = MIN_LOADING_DURATION_MS,
  timerRef?: React.MutableRefObject<ReturnType<typeof setTimeout> | null>,
): void {
  setLoading(true);
  const start = Date.now();
  let released = false;

  const release = () => {
    if (released) return;
    released = true;
    const elapsed = Date.now() - start;
    const remaining = Math.max(0, minMs - elapsed);
    if (remaining === 0) {
      setLoading(false);
    } else {
      const id = setTimeout(() => {
        if (timerRef) timerRef.current = null;
        setLoading(false);
      }, remaining);
      if (timerRef) timerRef.current = id;
    }
  };

  try {
    const result = action();
    if (result && typeof result.then === 'function') {
      void result.finally(release);
    } else {
      release();
    }
  } catch (err) {
    release();
    throw err;
  }
}

export function useAutoLoading(
  loading: boolean | undefined,
  autoLoading: boolean,
  disabled: boolean | undefined,
  onClick: React.MouseEventHandler<HTMLButtonElement> | undefined,
) {
  const [internalLoading, setInternalLoading] = useState(false);
  const isControlled = loading !== undefined;
  const isLoading = isControlled ? loading : internalLoading;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 组件卸载时清理定时器
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    if (isLoading || disabled) return;
    if (!autoLoading || isControlled) {
      onClick?.(e);
      return;
    }
    runWithMinLoadingDuration(
      setInternalLoading,
      () => onClick?.(e),
      undefined,
      timerRef,
    );
  }, [isLoading, disabled, autoLoading, isControlled, onClick]);

  return { isLoading, handleClick, showLoading: loading || (autoLoading && internalLoading) };
}
